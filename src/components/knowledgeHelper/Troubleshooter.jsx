// C:\Users\larho\suka-smart-assistant\src\components\knowledgeHelper\Troubleshooter.jsx
/* eslint-disable no-console */
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Search,
  Sparkles,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  ClipboardList,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  Save,
  X,
  Tag,
  Clock,
  ExternalLink,
  Lightbulb,
  ShieldAlert,
} from "lucide-react";
import SafetyAlertCard, { makeSafetyAlert } from "./SafetyAlertCard";

/**
 * SSA • Knowledge Helper • Troubleshooter
 * -----------------------------------------------------------------------------
 * A guided troubleshooting UI for SSA pages (cooking, cleaning, garden, tools).
 *
 * What it does
 *  - Captures "what's wrong" with a guided form (symptoms + context)
 *  - Runs deterministic rule-based checks (client-side, no AI required)
 *  - Shows step-by-step checks with outcomes (Pass/Fail/Skip)
 *  - Produces a best-guess diagnosis list with confidence and next actions
 *  - Emits safety alerts when a symptom implies risk
 *  - Optionally logs a troubleshooting session to Dexie (if table exists) or KV
 *  - Emits eventBus events for automation + dashboards
 *
 * Production goals
 *  - Works even if db/eventBus/repos are missing (graceful fallback)
 *  - No Node imports; browser-safe
 *  - No HTML injection; safe external links
 *  - Accessible: keyboard-friendly, clear focus handling
 *
 * -----------------------------------------------------------------------------
 * Suggested Dexie tables (optional):
 *  - knowledgeTroubleshootSessions: "&id, householdId, domain, createdAt, updatedAt, status"
 *  - knowledgeTroubleshootNotes: "++pk, sessionId, createdAt"
 *  - kv/settings/appSettings as fallback
 *
 * Events (stable):
 *  - knowledge.troubleshooter.started
 *  - knowledge.troubleshooter.updated
 *  - knowledge.troubleshooter.saved
 *  - knowledge.troubleshooter.completed
 *
 * -----------------------------------------------------------------------------
 * Props
 *  - householdId: string (recommended)
 *  - userId: string (optional)
 *  - domain: string ("cooking"|"cleaning"|"garden"|"tools"|...)
 *  - title: string (optional)
 *  - initial: { issueText?, symptoms?, context? } (optional)
 *  - templates: array of custom issue templates (optional)
 *  - onClose: () => void (optional)
 *  - onSaved: (payload) => void (optional)
 *  - onCompleted: (payload) => void (optional)
 *  - compact: boolean
 */

const DEFAULT_SOURCE = "components/knowledgeHelper/Troubleshooter";
const EVENTS = Object.freeze({
  STARTED: "knowledge.troubleshooter.started",
  UPDATED: "knowledge.troubleshooter.updated",
  SAVED: "knowledge.troubleshooter.saved",
  COMPLETED: "knowledge.troubleshooter.completed",
});

const SESSION_TABLE_CANDIDATES = Object.freeze([
  "knowledgeTroubleshootSessions",
  "troubleshootSessions",
  "knowledgeSessions",
  "sessions",
]);

const KV_TABLE_CANDIDATES = Object.freeze(["kv", "settings", "appSettings"]);

const DEFAULT_DOMAIN = "general";

const OUTCOME = Object.freeze({
  UNKNOWN: "unknown",
  PASS: "pass",
  FAIL: "fail",
  SKIP: "skip",
});

const SEVERITY = Object.freeze({
  INFO: "info",
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
  CRITICAL: "critical",
});

function isObj(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function nowISO() {
  return new Date().toISOString();
}
function normalizeStr(v) {
  if (v == null) return "";
  return String(v).trim();
}
function normalizeKey(v) {
  return normalizeStr(v)
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^\w:.-]/g, "");
}
function safeUrl(u) {
  const s = normalizeStr(u);
  if (!s) return "";
  try {
    const url = new URL(s, window.location.origin);
    const proto = url.protocol.toLowerCase();
    if (proto === "http:" || proto === "https:") return url.toString();
    return "";
  } catch {
    return "";
  }
}
function clamp01(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}
function jclone(x) {
  return x == null ? x : JSON.parse(JSON.stringify(x));
}
function randomId(prefix = "ts") {
  const rnd =
    globalThis.crypto && typeof globalThis.crypto.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Math.random().toString(16).slice(2)}${Math.random()
          .toString(16)
          .slice(2)}`;
  return `${prefix}_${rnd.replace(/-/g, "").slice(0, 18)}`;
}

async function getDbAndBus() {
  let db = null;
  let eventBus = null;

  try {
    const mod = await import("@/services/db");
    db = mod.db || mod.default || null;
  } catch {
    try {
      const mod = await import("../../services/db");
      db = mod.db || mod.default || null;
    } catch {
      // ignore
    }
  }

  try {
    const mod = await import("@/services/events/eventBus");
    eventBus = mod.eventBus || mod.default || null;
  } catch {
    try {
      const mod = await import("../../services/events/eventBus");
      eventBus = mod.eventBus || mod.default || null;
    } catch {
      // ignore
    }
  }

  return { db, eventBus };
}

function hasTable(db, name) {
  try {
    if (!db?.tables) return false;
    return db.tables.some((t) => t?.name === name);
  } catch {
    return false;
  }
}
function pickTable(db, candidates) {
  for (const n of candidates) if (hasTable(db, n)) return n;
  return null;
}
function emit(bus, evt, payload) {
  try {
    if (!bus) return;
    if (typeof bus.emit === "function") bus.emit(evt, payload);
    else if (typeof bus.publish === "function") bus.publish(evt, payload);
  } catch (e) {
    console.warn("[Troubleshooter] event emit failed:", evt, e);
  }
}

function fmtWhen(iso) {
  const s = normalizeStr(iso);
  if (!s) return "";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ----------------------------------------------------------------------------
// Built-in templates + rules
// ----------------------------------------------------------------------------

const BUILTIN_TEMPLATES = Object.freeze([
  {
    id: "food_safety_temp",
    domain: "cooking",
    title: "Food safety concern",
    placeholder: "Example: Chicken left out for 3 hours; is it safe?",
    tags: ["food_safety", "temperature", "storage"],
    prompts: [
      {
        key: "food_type",
        label: "Food type",
        type: "text",
        placeholder: "Chicken, rice, stew...",
      },
      {
        key: "time_out",
        label: "Time at room temp (hours)",
        type: "number",
        min: 0,
        max: 72,
      },
      {
        key: "room_temp",
        label: "Room temperature (°F)",
        type: "number",
        min: 32,
        max: 120,
      },
      { key: "reheated", label: "Was it reheated?", type: "toggle" },
    ],
  },
  {
    id: "pressure_canner",
    domain: "cooking",
    title: "Pressure canner issue",
    placeholder: "Example: Pressure won’t build or gauge fluctuates.",
    tags: ["pressure_canning", "equipment", "safety"],
    prompts: [
      {
        key: "model",
        label: "Canner model",
        type: "text",
        placeholder: "Presto 23qt...",
      },
      {
        key: "symptom",
        label: "Symptom",
        type: "select",
        options: [
          "No pressure",
          "Low pressure",
          "Fluctuating",
          "Steam leak",
          "Lid stuck",
        ],
      },
      {
        key: "altitude_ft",
        label: "Altitude (ft)",
        type: "number",
        min: 0,
        max: 15000,
      },
    ],
  },
  {
    id: "chemical_mixing",
    domain: "cleaning",
    title: "Cleaning chemical safety",
    placeholder: "Example: Mixed products and now there’s a strong odor.",
    tags: ["chemical_safety", "ventilation"],
    prompts: [
      {
        key: "product_a",
        label: "Product A",
        type: "text",
        placeholder: "Bleach, ammonia...",
      },
      {
        key: "product_b",
        label: "Product B",
        type: "text",
        placeholder: "Vinegar, toilet cleaner...",
      },
      {
        key: "symptoms",
        label: "Any symptoms?",
        type: "text",
        placeholder: "Coughing, burning eyes...",
      },
      {
        key: "space",
        label: "Space",
        type: "select",
        options: ["Bathroom", "Kitchen", "Laundry", "Other"],
      },
    ],
  },
  {
    id: "garden_pest",
    domain: "garden",
    title: "Garden pest / damage",
    placeholder: "Example: Leaves are curling and sticky.",
    tags: ["garden", "pest", "diagnosis"],
    prompts: [
      {
        key: "plant",
        label: "Plant",
        type: "text",
        placeholder: "Tomatoes, okra...",
      },
      {
        key: "damage",
        label: "Damage pattern",
        type: "select",
        options: [
          "Holes",
          "Curling",
          "Yellowing",
          "Spots",
          "Stunted",
          "Sticky",
        ],
      },
      {
        key: "when",
        label: "When did it start?",
        type: "text",
        placeholder: "2 days ago...",
      },
    ],
  },
]);

/**
 * Deterministic rule engine
 * - returns:
 *    { checks: [...], hypotheses: [...], safetyAlerts: [...] }
 */
function runRules({
  domain,
  issueText,
  selectedTemplate,
  form,
  selectedSymptoms,
  context,
}) {
  const checks = [];
  const hypotheses = [];
  const safetyAlerts = [];

  const text = `${issueText || ""} ${JSON.stringify(form || {})}`.toLowerCase();

  // Helper to add a check
  const addCheck = (c) => {
    checks.push({
      id: c.id || randomId("chk"),
      title: normalizeStr(c.title) || "Check",
      why: normalizeStr(c.why) || "",
      how: normalizeStr(c.how) || "",
      expected: normalizeStr(c.expected) || "",
      safety: !!c.safety,
      outcome: OUTCOME.UNKNOWN,
      note: "",
      evidence: null,
      sources: Array.isArray(c.sources) ? c.sources : [],
      severity: c.severity || null,
    });
  };

  const addHyp = (h) => {
    hypotheses.push({
      id: h.id || randomId("hyp"),
      title: normalizeStr(h.title) || "Possible cause",
      confidence: clamp01(h.confidence ?? 0.3),
      rationale: normalizeStr(h.rationale) || "",
      nextActions: Array.isArray(h.nextActions)
        ? h.nextActions.map(normalizeStr).filter(Boolean)
        : [],
      sources: Array.isArray(h.sources) ? h.sources : [],
    });
  };

  // SAFETY: cleaning chemical mixing
  if (
    domain === "cleaning" ||
    text.includes("bleach") ||
    text.includes("ammonia") ||
    text.includes("toilet cleaner")
  ) {
    const a = (form?.product_a || "").toLowerCase();
    const b = (form?.product_b || "").toLowerCase();
    const mixed =
      (a.includes("bleach") &&
        (b.includes("ammonia") ||
          b.includes("toilet") ||
          b.includes("acid") ||
          b.includes("vinegar"))) ||
      (b.includes("bleach") &&
        (a.includes("ammonia") ||
          a.includes("toilet") ||
          a.includes("acid") ||
          a.includes("vinegar"))) ||
      text.includes("mixed bleach") ||
      text.includes("chlorine gas") ||
      text.includes("burning eyes");

    if (mixed) {
      safetyAlerts.push(
        makeSafetyAlert({
          severity: SEVERITY.CRITICAL,
          title: "Possible dangerous chemical fumes",
          summary:
            "If bleach was mixed with ammonia, acids (including many toilet cleaners), or vinegar, hazardous fumes can form. Move to fresh air and ventilate immediately.",
          details:
            "Do not continue cleaning. Open windows/doors, leave the area if you feel irritation, and avoid re-entering until fully ventilated. If you have breathing difficulty or severe symptoms, seek urgent help.",
          recommendations: [
            "Stop using chemicals; leave the area and ventilate.",
            "Rinse affected surfaces with plenty of water (only if safe to do so).",
            "If symptoms persist or worsen, seek medical advice urgently.",
          ],
          category: "chemical_safety",
          tags: ["bleach", "ammonia", "acids", "ventilation"],
          domains: ["cleaning"],
        })
      );

      addCheck({
        id: "chk_ventilate",
        title: "Ventilate immediately",
        why: "Hazardous fumes can irritate eyes/lungs.",
        how: "Open windows/doors; turn on exhaust fan; leave the space for several minutes.",
        expected: "Odor reduces and irritation improves.",
        safety: true,
        severity: SEVERITY.CRITICAL,
      });

      addHyp({
        id: "hyp_fumes",
        title: "Chemical fume exposure risk",
        confidence: 0.85,
        rationale:
          "The products mentioned can create irritant gases when combined.",
        nextActions: [
          "Ventilate and stop mixing products.",
          "Use only one product at a time; rinse between products.",
          "Consider switching to a single-purpose cleaner for the job.",
        ],
      });
    }
  }

  // Food safety: time/temperature at room temp (simple guidance)
  if (
    domain === "cooking" &&
    (selectedTemplate?.id === "food_safety_temp" ||
      text.includes("left out") ||
      text.includes("room temp"))
  ) {
    const hours = Number(form?.time_out);
    const roomF = Number(form?.room_temp);
    const hasHours = Number.isFinite(hours);
    const hasRoom = Number.isFinite(roomF);

    // General rule of thumb: 2 hours (or 1 hour if >90°F)
    const threshold = hasRoom && roomF >= 90 ? 1 : 2;

    addCheck({
      id: "chk_time_temp",
      title: "Check time + temperature exposure",
      why: "Perishable foods can grow bacteria quickly at room temperature.",
      how: "Estimate how long it stayed out and how warm the room was.",
      expected: `If it exceeded ~${threshold} hour(s), risk increases for many perishables.`,
      safety: true,
      severity: SEVERITY.HIGH,
    });

    if (hasHours && hours > threshold) {
      safetyAlerts.push(
        makeSafetyAlert({
          severity: SEVERITY.HIGH,
          title: "Food may be unsafe after extended room-temperature time",
          summary: `If a perishable food was at room temperature for more than ~${threshold} hour(s) (${
            threshold === 1
              ? "or more than 1 hour above 90°F"
              : "or more than 2 hours generally"
          }), it may not be safe to eat.`,
          details:
            "Reheating may not make unsafe food safe if toxins formed. When uncertain, the safest choice is to discard.",
          recommendations: [
            "When in doubt, discard the food.",
            "For future: cool quickly, refrigerate within 1–2 hours, use shallow containers.",
            "Use a food thermometer and safe cooling practices.",
          ],
          category: "food_safety",
          tags: ["time_temperature", "perishable", "refrigeration"],
          domains: ["cooking"],
        })
      );

      addHyp({
        id: "hyp_food_risk",
        title: "Time/temperature abuse",
        confidence: 0.8,
        rationale: `Reported time out (${hours}h) exceeds conservative guidance (~${threshold}h).`,
        nextActions: [
          "Discard the item if it’s perishable and exceeded safe time out.",
          "Clean any containers/utensils used and wash hands thoroughly.",
        ],
      });
    } else if (hasHours && hours <= threshold) {
      addHyp({
        id: "hyp_food_ok",
        title: "Likely OK if handled and cooled promptly",
        confidence: 0.55,
        rationale: `Reported time out (${hours}h) is within a conservative window (~${threshold}h).`,
        nextActions: [
          "Refrigerate promptly.",
          "Reheat to appropriate serving temperature if needed.",
        ],
      });
    }
  }

  // Pressure canner: common deterministic checks
  if (
    domain === "cooking" &&
    (selectedTemplate?.id === "pressure_canner" ||
      text.includes("pressure") ||
      text.includes("canner"))
  ) {
    addCheck({
      id: "chk_gasket",
      title: "Inspect sealing ring / gasket",
      why: "A worn or mis-seated gasket can leak steam and prevent pressure build.",
      how: "Ensure gasket is present, flexible, clean, and seated correctly.",
      expected: "Steam does not leak excessively; pressure rises normally.",
      safety: true,
      severity: SEVERITY.HIGH,
    });

    addCheck({
      id: "chk_vent_pipe",
      title: "Check vent pipe and weight/regulator",
      why: "A blocked vent or incorrect regulator placement causes pressure problems.",
      how: "Ensure vent pipe is clear; weight/regulator is seated; follow manual venting steps.",
      expected: "Steady venting during purge and stable pressure afterward.",
      safety: true,
      severity: SEVERITY.HIGH,
    });

    addHyp({
      id: "hyp_canner_leak",
      title: "Steam leak or incomplete venting",
      confidence: 0.55,
      rationale:
        "Most pressure instability issues come from sealing/venting problems.",
      nextActions: [
        "Re-seat lid and gasket; clean mating surfaces.",
        "Verify regulator/weight and vent pipe are correct and clear.",
        "Follow the manual’s venting (purge) time before pressurizing.",
      ],
    });

    const symptom = normalizeStr(form?.symptom).toLowerCase();
    if (symptom.includes("lid stuck")) {
      safetyAlerts.push(
        makeSafetyAlert({
          severity: SEVERITY.CRITICAL,
          title: "Do not force-open a pressure canner lid",
          summary:
            "If a lid is stuck, assume residual pressure. Forcing it can cause serious injury.",
          details:
            "Turn off heat, let it cool naturally, and confirm pressure is fully released per the manufacturer instructions.",
          recommendations: [
            "Turn off heat and let it cool naturally.",
            "Do not run water over the lid unless the manual permits.",
            "Confirm the lock drops / gauge reads zero before attempting to open.",
          ],
          category: "equipment_safety",
          tags: ["pressure", "burn_risk"],
          domains: ["cooking"],
        })
      );
    }
  }

  // Generic troubleshooting scaffolding
  if (!checks.length) {
    addCheck({
      id: "chk_reproduce",
      title: "Reproduce the issue safely",
      why: "Consistent reproduction narrows causes.",
      how: "Describe the exact steps that lead to the issue and what changes it.",
      expected: "A repeatable pattern you can test against.",
      safety: false,
    });

    addCheck({
      id: "chk_recent_change",
      title: "Identify what changed recently",
      why: "New variables are frequent root causes.",
      how: "Consider new ingredients, tools, weather, products, or schedule changes.",
      expected: "A short list of likely triggers.",
      safety: false,
    });

    addHyp({
      id: "hyp_unknown",
      title: "Needs more specific symptoms",
      confidence: 0.25,
      rationale: "Not enough information to propose a strong root cause yet.",
      nextActions: [
        "Add key details (time/temperature, product names, model numbers, photos).",
        "Run the basic checks and mark outcomes.",
      ],
    });
  }

  // Incorporate selectedSymptoms into an explanation (lightweight)
  if (Array.isArray(selectedSymptoms) && selectedSymptoms.length) {
    const ss = selectedSymptoms.map(normalizeStr).filter(Boolean);
    if (ss.length) {
      hypotheses.forEach((h) => {
        h.rationale = h.rationale
          ? `${h.rationale} (Observed: ${ss.join(", ")})`
          : `Observed: ${ss.join(", ")}`;
      });
    }
  }

  // Apply context fields lightly
  if (context?.location) {
    addCheck({
      id: "chk_context_location",
      title: "Confirm environment constraints",
      why: "Space/ventilation/temperature can change the safest next step.",
      how: `Verify conditions in: ${normalizeStr(context.location)}.`,
      expected: "Your next action fits the environment.",
      safety: false,
    });
  }

  // Sort hypotheses by confidence desc
  hypotheses.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));

  return { checks, hypotheses, safetyAlerts };
}

// ----------------------------------------------------------------------------
// Persistence helpers (best effort)
// ----------------------------------------------------------------------------

async function saveSessionToStorage({ session, householdId, domain }) {
  const { db } = await getDbAndBus();
  if (!db) return { ok: false, mode: "none" };

  const primary = pickTable(db, SESSION_TABLE_CANDIDATES);
  const kv = pickTable(db, KV_TABLE_CANDIDATES);

  const at = nowISO();
  const s = { ...session, updatedAt: at };

  if (primary) {
    try {
      const t = db.table(primary);
      await t.put({
        id: s.id,
        householdId: householdId || null,
        userId: s.userId || null,
        domain: domain || DEFAULT_DOMAIN,
        status: s.status || "active",
        title: s.title || null,
        createdAt: s.createdAt || at,
        updatedAt: at,
        payload: jclone(s),
      });
      return { ok: true, mode: "table", table: primary };
    } catch (e) {
      console.warn("[Troubleshooter] save to table failed", e);
    }
  }

  if (kv) {
    try {
      const key = `knowledge.troubleshoot.${s.id}`;
      await db.table(kv).put({
        key,
        id: key,
        value: jclone(s),
        householdId: householdId || null,
        domain: domain || DEFAULT_DOMAIN,
        updatedAt: at,
      });
      return { ok: true, mode: "kv", table: kv };
    } catch (e) {
      console.warn("[Troubleshooter] save to kv failed", e);
    }
  }

  return { ok: false, mode: "none" };
}

// ----------------------------------------------------------------------------
// UI Components (small internal helpers)
// ----------------------------------------------------------------------------

function Pill({ icon, children }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-white/70 border border-black/5 px-2 py-0.5 text-xs text-slate-700">
      {icon ? (
        <span className="inline-flex h-3.5 w-3.5 items-center justify-center">
          {icon}
        </span>
      ) : null}
      {children}
    </span>
  );
}

function OutcomeBadge({ outcome }) {
  const o = outcome || OUTCOME.UNKNOWN;
  const meta =
    o === OUTCOME.PASS
      ? {
          Icon: CheckCircle2,
          label: "Pass",
          cls: "bg-emerald-100 text-emerald-900",
        }
      : o === OUTCOME.FAIL
      ? { Icon: XCircle, label: "Fail", cls: "bg-rose-100 text-rose-900" }
      : o === OUTCOME.SKIP
      ? {
          Icon: ChevronRight,
          label: "Skip",
          cls: "bg-slate-100 text-slate-800",
        }
      : {
          Icon: AlertTriangle,
          label: "Unknown",
          cls: "bg-amber-100 text-amber-900",
        };

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${meta.cls}`}
    >
      <meta.Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {meta.label}
    </span>
  );
}

function ConfidenceBar({ value }) {
  const pct = Math.round(clamp01(value) * 100);
  return (
    <div className="flex items-center gap-2">
      <div
        className="h-2 w-24 rounded-full bg-slate-200 overflow-hidden"
        aria-hidden="true"
      >
        <div className="h-full bg-slate-900" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-slate-700">{pct}%</span>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Main Component
// ----------------------------------------------------------------------------

export default function Troubleshooter({
  householdId = "",
  userId = "",
  domain = DEFAULT_DOMAIN,
  title = "Troubleshooter",
  initial = null,
  templates = null,
  onClose,
  onSaved,
  onCompleted,
  compact = false,
}) {
  const [busy, setBusy] = useState(false);
  const [savedToast, setSavedToast] = useState("");
  const [error, setError] = useState("");

  // Session state
  const [sessionId] = useState(() => randomId("ts"));
  const [status, setStatus] = useState("active"); // active|completed
  const [createdAt] = useState(() => nowISO());

  // User inputs
  const [templateId, setTemplateId] = useState("");
  const [issueText, setIssueText] = useState("");
  const [symptoms, setSymptoms] = useState([]); // tags/strings
  const [context, setContext] = useState({
    location: "",
    device: "",
    notes: "",
  });
  const [form, setForm] = useState({}); // template dynamic prompts

  // Derived output
  const [checks, setChecks] = useState([]);
  const [hypotheses, setHypotheses] = useState([]);
  const [alerts, setAlerts] = useState([]);

  const [expandedChecks, setExpandedChecks] = useState(true);
  const [expandedHyp, setExpandedHyp] = useState(true);
  const [expandedInput, setExpandedInput] = useState(true);

  const [symptomInput, setSymptomInput] = useState("");

  const issueRef = useRef(null);

  const allTemplates = useMemo(() => {
    const arr = Array.isArray(templates) ? templates : BUILTIN_TEMPLATES;
    return arr
      .map((t) => ({
        id: normalizeStr(t.id) || randomId("tmpl"),
        domain: normalizeStr(t.domain) || DEFAULT_DOMAIN,
        title: normalizeStr(t.title) || "Template",
        placeholder: normalizeStr(t.placeholder),
        tags: Array.isArray(t.tags)
          ? t.tags.map(normalizeStr).filter(Boolean)
          : [],
        prompts: Array.isArray(t.prompts) ? t.prompts : [],
      }))
      .filter(Boolean);
  }, [templates]);

  const domainTemplates = useMemo(() => {
    const d = normalizeStr(domain) || DEFAULT_DOMAIN;
    // show matching domain first, then general
    const exact = allTemplates.filter((t) => t.domain === d);
    const gen = allTemplates.filter((t) => t.domain === DEFAULT_DOMAIN);
    return [...exact, ...gen];
  }, [allTemplates, domain]);

  const selectedTemplate = useMemo(() => {
    const id = normalizeStr(templateId);
    if (!id) return null;
    return domainTemplates.find((t) => t.id === id) || null;
  }, [templateId, domainTemplates]);

  // Init from initial prop
  useEffect(() => {
    if (!initial || !isObj(initial)) return;
    if (initial.issueText) setIssueText(normalizeStr(initial.issueText));
    if (Array.isArray(initial.symptoms))
      setSymptoms(initial.symptoms.map(normalizeStr).filter(Boolean));
    if (isObj(initial.context))
      setContext((c) => ({ ...c, ...initial.context }));
    if (isObj(initial.form)) setForm((f) => ({ ...f, ...initial.form }));
    if (initial.templateId) setTemplateId(normalizeStr(initial.templateId));
  }, [initial]);

  // Emit started event once
  useEffect(() => {
    (async () => {
      const { eventBus } = await getDbAndBus();
      emit(eventBus, EVENTS.STARTED, {
        householdId: normalizeStr(householdId) || null,
        userId: normalizeStr(userId) || null,
        domain: normalizeStr(domain) || DEFAULT_DOMAIN,
        sessionId,
        createdAt,
        source: DEFAULT_SOURCE,
      });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-clear toast
  useEffect(() => {
    if (!savedToast) return;
    const t = setTimeout(() => setSavedToast(""), 2500);
    return () => clearTimeout(t);
  }, [savedToast]);

  const pad = compact ? "p-3" : "p-4";

  function addSymptom() {
    const s = normalizeStr(symptomInput);
    if (!s) return;
    const key = s;
    setSymptoms((prev) => Array.from(new Set([...prev, key])));
    setSymptomInput("");
  }

  function removeSymptom(s) {
    setSymptoms((prev) => prev.filter((x) => x !== s));
  }

  function resetAll() {
    setTemplateId("");
    setIssueText("");
    setSymptoms([]);
    setContext({ location: "", device: "", notes: "" });
    setForm({});
    setChecks([]);
    setHypotheses([]);
    setAlerts([]);
    setError("");
    setExpandedInput(true);
    setExpandedChecks(true);
    setExpandedHyp(true);
    setTimeout(() => issueRef.current?.focus?.(), 50);
  }

  function onFormChange(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function updateCheckOutcome(checkId, outcome) {
    setChecks((prev) =>
      prev.map((c) => (c.id === checkId ? { ...c, outcome } : c))
    );
  }

  function updateCheckNote(checkId, note) {
    setChecks((prev) =>
      prev.map((c) => (c.id === checkId ? { ...c, note } : c))
    );
  }

  function runTroubleshooting() {
    setError("");
    const d = normalizeStr(domain) || DEFAULT_DOMAIN;
    const out = runRules({
      domain: d,
      issueText,
      selectedTemplate,
      form,
      selectedSymptoms: symptoms,
      context,
    });

    setChecks(out.checks || []);
    setHypotheses(out.hypotheses || []);
    setAlerts(out.safetyAlerts || []);
    setExpandedChecks(true);
    setExpandedHyp(true);

    // Emit updated event
    (async () => {
      const { eventBus } = await getDbAndBus();
      emit(eventBus, EVENTS.UPDATED, {
        householdId: normalizeStr(householdId) || null,
        userId: normalizeStr(userId) || null,
        domain: d,
        sessionId,
        updatedAt: nowISO(),
        source: DEFAULT_SOURCE,
        payload: {
          templateId: selectedTemplate?.id || null,
          issueText: normalizeStr(issueText),
          symptoms: jclone(symptoms),
          context: jclone(context),
          form: jclone(form),
          checksCount: (out.checks || []).length,
          hypothesesCount: (out.hypotheses || []).length,
          alertsCount: (out.safetyAlerts || []).length,
        },
      });
    })();
  }

  // Derive "progress" and "confidence" based on outcomes
  const progress = useMemo(() => {
    if (!checks.length) return { done: 0, total: 0, pct: 0 };
    const total = checks.length;
    const done = checks.filter((c) => c.outcome !== OUTCOME.UNKNOWN).length;
    const pct = total ? Math.round((done / total) * 100) : 0;
    return { done, total, pct };
  }, [checks]);

  const overallConfidence = useMemo(() => {
    // Simple aggregator:
    // - If many FAIL on safety-related checks, increase confidence in top hypotheses
    // - Otherwise average top 2 hypothesis confidences, weighted by progress
    const base =
      hypotheses.length === 0
        ? 0
        : hypotheses
            .slice(0, 2)
            .map((h) => clamp01(h.confidence))
            .reduce((a, b) => a + b, 0) / Math.min(2, hypotheses.length);

    const safetyFails = checks.filter(
      (c) => c.safety && c.outcome === OUTCOME.FAIL
    ).length;
    const safetyBoost = Math.min(0.15, safetyFails * 0.08);

    const progBoost = Math.min(0.2, (progress.pct / 100) * 0.2);

    return clamp01(base + safetyBoost + progBoost);
  }, [hypotheses, checks, progress.pct]);

  function buildSessionPayload(finalStatus = "active") {
    const d = normalizeStr(domain) || DEFAULT_DOMAIN;
    const payload = {
      id: sessionId,
      householdId: normalizeStr(householdId) || null,
      userId: normalizeStr(userId) || null,
      domain: d,
      status: finalStatus,
      title:
        normalizeStr(issueText).slice(0, 120) ||
        (selectedTemplate?.title
          ? `${selectedTemplate.title}`
          : "Troubleshoot session"),
      createdAt,
      updatedAt: nowISO(),
      source: DEFAULT_SOURCE,

      inputs: {
        templateId: selectedTemplate?.id || null,
        issueText: normalizeStr(issueText),
        symptoms: jclone(symptoms),
        context: jclone(context),
        form: jclone(form),
      },
      outputs: {
        checks: jclone(checks),
        hypotheses: jclone(hypotheses),
        alerts: jclone(alerts),
        progress: jclone(progress),
        overallConfidence,
      },
    };
    return payload;
  }

  async function saveSession() {
    setBusy(true);
    setError("");
    try {
      const payload = buildSessionPayload(status);
      const res = await saveSessionToStorage({
        session: payload,
        householdId,
        domain,
      });
      const { eventBus } = await getDbAndBus();

      emit(eventBus, EVENTS.SAVED, {
        householdId: payload.householdId,
        userId: payload.userId,
        domain: payload.domain,
        sessionId: payload.id,
        updatedAt: payload.updatedAt,
        source: DEFAULT_SOURCE,
        persistence: res.mode,
        table: res.table || null,
      });

      setSavedToast(res.ok ? "Saved" : "Saved locally (no DB)");
      onSaved?.(payload);
    } catch (e) {
      console.warn("[Troubleshooter] saveSession failed", e);
      setError(
        "Couldn’t save the troubleshooting session. Check console for details."
      );
    } finally {
      setBusy(false);
    }
  }

  async function completeSession() {
    setBusy(true);
    setError("");
    try {
      const payload = buildSessionPayload("completed");
      setStatus("completed");

      await saveSessionToStorage({ session: payload, householdId, domain });

      const { eventBus } = await getDbAndBus();
      emit(eventBus, EVENTS.COMPLETED, {
        householdId: payload.householdId,
        userId: payload.userId,
        domain: payload.domain,
        sessionId: payload.id,
        updatedAt: payload.updatedAt,
        source: DEFAULT_SOURCE,
      });

      setSavedToast("Completed");
      onCompleted?.(payload);
    } catch (e) {
      console.warn("[Troubleshooter] completeSession failed", e);
      setError("Couldn’t complete the session. Check console for details.");
    } finally {
      setBusy(false);
    }
  }

  // Render prompt fields for selected template
  const promptFields = useMemo(() => {
    const prompts = selectedTemplate?.prompts || [];
    return prompts.map((p) => {
      const key = normalizeStr(p.key);
      const label = normalizeStr(p.label) || key;
      const type = normalizeStr(p.type) || "text";
      const value = form[key];

      if (!key) return null;

      if (type === "toggle") {
        return (
          <label
            key={key}
            className="flex items-center justify-between gap-3 rounded-xl bg-white/70 border border-black/5 px-3 py-2"
          >
            <span className="text-sm font-medium text-slate-900">{label}</span>
            <button
              type="button"
              onClick={() => onFormChange(key, !value)}
              className={[
                "inline-flex items-center rounded-full px-3 py-1 text-sm font-medium",
                value
                  ? "bg-slate-900 text-white"
                  : "bg-slate-100 text-slate-800",
              ].join(" ")}
              aria-pressed={!!value}
            >
              {value ? "Yes" : "No"}
            </button>
          </label>
        );
      }

      if (type === "select") {
        const options = Array.isArray(p.options) ? p.options : [];
        return (
          <label key={key} className="block">
            <span className="text-sm font-medium text-slate-900">{label}</span>
            <select
              value={value ?? ""}
              onChange={(e) => onFormChange(key, e.target.value)}
              className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-slate-400"
            >
              <option value="">Select…</option>
              {options.map((opt) => (
                <option key={String(opt)} value={String(opt)}>
                  {String(opt)}
                </option>
              ))}
            </select>
          </label>
        );
      }

      if (type === "number") {
        return (
          <label key={key} className="block">
            <span className="text-sm font-medium text-slate-900">{label}</span>
            <input
              type="number"
              value={value ?? ""}
              min={p.min ?? undefined}
              max={p.max ?? undefined}
              onChange={(e) =>
                onFormChange(
                  key,
                  e.target.value === "" ? "" : Number(e.target.value)
                )
              }
              placeholder={normalizeStr(p.placeholder)}
              className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-slate-400"
            />
          </label>
        );
      }

      // default text
      return (
        <label key={key} className="block">
          <span className="text-sm font-medium text-slate-900">{label}</span>
          <input
            type="text"
            value={value ?? ""}
            onChange={(e) => onFormChange(key, e.target.value)}
            placeholder={normalizeStr(p.placeholder)}
            className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-slate-400"
          />
        </label>
      );
    });
  }, [selectedTemplate, form]);

  const canRun = useMemo(() => {
    const txt = normalizeStr(issueText);
    // Allow run if there is either an issueText or a selected template.
    return !!txt || !!selectedTemplate;
  }, [issueText, selectedTemplate]);

  return (
    <div className="w-full">
      <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
        {/* Header */}
        <div className={`${pad} flex items-start justify-between gap-3`}>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold text-slate-900 truncate">
                {title}
              </h2>
              <Pill icon={<Tag className="h-3.5 w-3.5" aria-hidden="true" />}>
                {normalizeStr(domain) || DEFAULT_DOMAIN}
              </Pill>
              <Pill icon={<Clock className="h-3.5 w-3.5" aria-hidden="true" />}>
                {fmtWhen(createdAt)}
              </Pill>
              {status === "completed" ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-900">
                  <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                  Completed
                </span>
              ) : null}
              {savedToast ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-800">
                  <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                  {savedToast}
                </span>
              ) : null}
            </div>
            <p className="mt-1 text-sm text-slate-600">
              Capture symptoms, run checks, and record outcomes. This stays
              deterministic and safe by default.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={resetAll}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50"
              title="Reset"
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              Reset
            </button>

            {typeof onClose === "function" ? (
              <button
                type="button"
                onClick={onClose}
                className="inline-flex items-center justify-center rounded-xl border border-slate-200 bg-white p-2 text-slate-700 hover:bg-slate-50"
                aria-label="Close troubleshooter"
                title="Close"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            ) : null}
          </div>
        </div>

        {/* Error */}
        {error ? (
          <div className="px-4 pb-4">
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900">
              {error}
            </div>
          </div>
        ) : null}

        {/* Inputs */}
        <div className="border-t border-slate-100">
          <button
            type="button"
            onClick={() => setExpandedInput((v) => !v)}
            className={`${pad} w-full flex items-center justify-between gap-3 text-left`}
            aria-expanded={expandedInput}
          >
            <div className="flex items-center gap-2">
              <ClipboardList
                className="h-5 w-5 text-slate-900"
                aria-hidden="true"
              />
              <span className="font-semibold text-slate-900">
                Describe the issue
              </span>
              <span className="text-xs text-slate-600">
                Template + symptoms + context
              </span>
            </div>
            {expandedInput ? (
              <ChevronUp className="h-4 w-4" />
            ) : (
              <ChevronDown className="h-4 w-4" />
            )}
          </button>

          {expandedInput ? (
            <div className={`${pad} pt-0 space-y-4`}>
              {/* Template selector */}
              <div className="grid gap-3 md:grid-cols-2">
                <label className="block">
                  <span className="text-sm font-medium text-slate-900">
                    Template
                  </span>
                  <select
                    value={templateId}
                    onChange={(e) => {
                      setTemplateId(e.target.value);
                      setForm({});
                    }}
                    className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-slate-400"
                  >
                    <option value="">No template</option>
                    {domainTemplates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.title}
                      </option>
                    ))}
                  </select>
                  {selectedTemplate?.placeholder ? (
                    <p className="mt-1 text-xs text-slate-600">
                      {selectedTemplate.placeholder}
                    </p>
                  ) : null}
                </label>

                <label className="block">
                  <span className="text-sm font-medium text-slate-900">
                    Issue summary
                  </span>
                  <input
                    ref={issueRef}
                    type="text"
                    value={issueText}
                    onChange={(e) => setIssueText(e.target.value)}
                    placeholder="Write what’s wrong in one sentence…"
                    className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-slate-400"
                  />
                </label>
              </div>

              {/* Template prompts */}
              {selectedTemplate?.prompts?.length ? (
                <div className="grid gap-3 md:grid-cols-2">
                  {promptFields.filter(Boolean)}
                </div>
              ) : null}

              {/* Symptoms */}
              <div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-medium text-slate-900">
                    Symptoms / clues
                  </span>
                  {selectedTemplate?.tags?.length ? (
                    <div className="flex flex-wrap gap-2">
                      {selectedTemplate.tags.slice(0, 6).map((t) => (
                        <button
                          key={t}
                          type="button"
                          onClick={() =>
                            setSymptoms((prev) =>
                              Array.from(new Set([...prev, t]))
                            )
                          }
                          className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700 hover:bg-slate-200"
                          title="Add tag"
                        >
                          + {t}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>

                <div className="mt-2 flex flex-wrap gap-2">
                  {symptoms.map((s) => (
                    <span
                      key={s}
                      className="inline-flex items-center gap-2 rounded-full bg-white border border-slate-200 px-2 py-0.5 text-xs text-slate-700"
                    >
                      {s}
                      <button
                        type="button"
                        onClick={() => removeSymptom(s)}
                        className="rounded-full p-0.5 hover:bg-slate-100"
                        aria-label={`Remove symptom ${s}`}
                        title="Remove"
                      >
                        <X className="h-3 w-3" aria-hidden="true" />
                      </button>
                    </span>
                  ))}
                </div>

                <div className="mt-2 flex items-center gap-2">
                  <input
                    type="text"
                    value={symptomInput}
                    onChange={(e) => setSymptomInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addSymptom();
                      }
                    }}
                    placeholder="Add a symptom (press Enter)…"
                    className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-slate-400"
                  />
                  <button
                    type="button"
                    onClick={addSymptom}
                    className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800"
                  >
                    Add
                  </button>
                </div>
              </div>

              {/* Context */}
              <div className="grid gap-3 md:grid-cols-3">
                <label className="block">
                  <span className="text-sm font-medium text-slate-900">
                    Location
                  </span>
                  <input
                    type="text"
                    value={context.location || ""}
                    onChange={(e) =>
                      setContext((c) => ({ ...c, location: e.target.value }))
                    }
                    placeholder="Kitchen, bathroom, greenhouse…"
                    className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-slate-400"
                  />
                </label>
                <label className="block">
                  <span className="text-sm font-medium text-slate-900">
                    Device / tool
                  </span>
                  <input
                    type="text"
                    value={context.device || ""}
                    onChange={(e) =>
                      setContext((c) => ({ ...c, device: e.target.value }))
                    }
                    placeholder="Model, product, equipment…"
                    className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-slate-400"
                  />
                </label>
                <label className="block md:col-span-3">
                  <span className="text-sm font-medium text-slate-900">
                    Extra notes
                  </span>
                  <textarea
                    rows={compact ? 2 : 3}
                    value={context.notes || ""}
                    onChange={(e) =>
                      setContext((c) => ({ ...c, notes: e.target.value }))
                    }
                    placeholder="Anything else that might matter…"
                    className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-slate-400"
                  />
                </label>
              </div>

              {/* Run */}
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={!canRun || busy}
                  onClick={runTroubleshooting}
                  className={[
                    "inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium",
                    canRun && !busy
                      ? "bg-slate-900 text-white hover:bg-slate-800"
                      : "bg-slate-100 text-slate-500 cursor-not-allowed",
                  ].join(" ")}
                >
                  <Search className="h-4 w-4" aria-hidden="true" />
                  Run checks
                </button>

                <div className="ml-auto flex items-center gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={saveSession}
                    className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50 disabled:opacity-50"
                  >
                    <Save className="h-4 w-4" aria-hidden="true" />
                    Save
                  </button>

                  <button
                    type="button"
                    disabled={busy || status === "completed"}
                    onClick={completeSession}
                    className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50 disabled:opacity-50"
                    title="Mark completed"
                  >
                    <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                    Complete
                  </button>
                </div>
              </div>

              {/* Summary strip */}
              {checks.length || hypotheses.length || alerts.length ? (
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="inline-flex items-center gap-1 font-medium text-slate-900">
                      <Sparkles className="h-4 w-4" aria-hidden="true" />
                      Summary
                    </span>
                    <span className="text-slate-700">
                      Checks: {checks.length} • Hypotheses: {hypotheses.length}{" "}
                      • Alerts: {alerts.length}
                    </span>
                    <span className="ml-auto text-slate-700">
                      Progress: {progress.done}/{progress.total} ({progress.pct}
                      %)
                    </span>
                    <span className="inline-flex items-center gap-2 text-slate-700">
                      Confidence:
                      <ConfidenceBar value={overallConfidence} />
                    </span>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* Safety Alerts */}
        {alerts.length ? (
          <div className="border-t border-slate-100">
            <div className={`${pad} pb-2 flex items-center gap-2`}>
              <ShieldAlert
                className="h-5 w-5 text-slate-900"
                aria-hidden="true"
              />
              <span className="font-semibold text-slate-900">
                Safety alerts
              </span>
              <span className="text-xs text-slate-600">Act on these first</span>
            </div>
            <div className={`${pad} pt-0 space-y-3`}>
              {alerts.map((al) => (
                <SafetyAlertCard
                  key={al.id}
                  alert={al}
                  defaultExpanded={
                    al.severity === "high" || al.severity === "critical"
                  }
                  onDismiss={null}
                  actions={[]}
                  compact={compact}
                />
              ))}
            </div>
          </div>
        ) : null}

        {/* Checks */}
        <div className="border-t border-slate-100">
          <button
            type="button"
            onClick={() => setExpandedChecks((v) => !v)}
            className={`${pad} w-full flex items-center justify-between gap-3 text-left`}
            aria-expanded={expandedChecks}
          >
            <div className="flex items-center gap-2">
              <ClipboardList
                className="h-5 w-5 text-slate-900"
                aria-hidden="true"
              />
              <span className="font-semibold text-slate-900">
                Step-by-step checks
              </span>
              <span className="text-xs text-slate-600">
                Mark outcomes as you test
              </span>
            </div>
            {expandedChecks ? (
              <ChevronUp className="h-4 w-4" />
            ) : (
              <ChevronDown className="h-4 w-4" />
            )}
          </button>

          {expandedChecks ? (
            <div className={`${pad} pt-0 space-y-3`}>
              {!checks.length ? (
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
                  Run checks to generate a checklist.
                </div>
              ) : null}

              {checks.map((c) => (
                <div
                  key={c.id}
                  className="rounded-2xl border border-slate-200 bg-white shadow-sm"
                >
                  <div className="p-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h4 className="font-semibold text-slate-900">
                            {c.title}
                          </h4>
                          <OutcomeBadge outcome={c.outcome} />
                          {c.safety ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">
                              <AlertTriangle
                                className="h-3.5 w-3.5"
                                aria-hidden="true"
                              />
                              Safety
                            </span>
                          ) : null}
                        </div>

                        {c.why ? (
                          <p className="mt-1 text-sm text-slate-700">{c.why}</p>
                        ) : null}

                        <div className="mt-2 space-y-1 text-sm text-slate-700">
                          {c.how ? (
                            <div className="flex gap-2">
                              <span className="font-medium text-slate-900">
                                How:
                              </span>
                              <span>{c.how}</span>
                            </div>
                          ) : null}
                          {c.expected ? (
                            <div className="flex gap-2">
                              <span className="font-medium text-slate-900">
                                Expected:
                              </span>
                              <span>{c.expected}</span>
                            </div>
                          ) : null}
                        </div>
                      </div>

                      <div className="flex flex-col items-end gap-2">
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() =>
                              updateCheckOutcome(c.id, OUTCOME.PASS)
                            }
                            className="rounded-xl bg-emerald-100 px-3 py-1.5 text-sm font-medium text-emerald-900 hover:bg-emerald-200"
                          >
                            Pass
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              updateCheckOutcome(c.id, OUTCOME.FAIL)
                            }
                            className="rounded-xl bg-rose-100 px-3 py-1.5 text-sm font-medium text-rose-900 hover:bg-rose-200"
                          >
                            Fail
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              updateCheckOutcome(c.id, OUTCOME.SKIP)
                            }
                            className="rounded-xl bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-200"
                          >
                            Skip
                          </button>
                        </div>
                      </div>
                    </div>

                    <div className="mt-3">
                      <label className="block">
                        <span className="text-xs font-medium text-slate-700">
                          Notes / evidence
                        </span>
                        <input
                          type="text"
                          value={c.note || ""}
                          onChange={(e) =>
                            updateCheckNote(c.id, e.target.value)
                          }
                          placeholder="What did you observe?"
                          className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-slate-400"
                        />
                      </label>
                    </div>

                    {Array.isArray(c.sources) && c.sources.length ? (
                      <div className="mt-3">
                        <span className="text-xs font-medium text-slate-700">
                          Sources
                        </span>
                        <ul className="mt-1 space-y-2">
                          {c.sources.map((s, idx) => {
                            const label = normalizeStr(s?.label) || "Source";
                            const url = safeUrl(s?.url);
                            return (
                              <li
                                key={`${idx}-${label}`}
                                className="flex items-center justify-between gap-3 rounded-xl bg-slate-50 border border-slate-200 px-3 py-2"
                              >
                                <span className="min-w-0 truncate text-sm text-slate-800">
                                  {label}
                                </span>
                                {url ? (
                                  <a
                                    href={url}
                                    target="_blank"
                                    rel="noreferrer noopener"
                                    className="inline-flex items-center gap-1 text-sm font-medium text-slate-900 hover:underline"
                                  >
                                    Open{" "}
                                    <ExternalLink
                                      className="h-4 w-4"
                                      aria-hidden="true"
                                    />
                                  </a>
                                ) : null}
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        {/* Hypotheses */}
        <div className="border-t border-slate-100">
          <button
            type="button"
            onClick={() => setExpandedHyp((v) => !v)}
            className={`${pad} w-full flex items-center justify-between gap-3 text-left`}
            aria-expanded={expandedHyp}
          >
            <div className="flex items-center gap-2">
              <Lightbulb
                className="h-5 w-5 text-slate-900"
                aria-hidden="true"
              />
              <span className="font-semibold text-slate-900">
                Likely causes
              </span>
              <span className="text-xs text-slate-600">
                Ordered by confidence
              </span>
            </div>
            {expandedHyp ? (
              <ChevronUp className="h-4 w-4" />
            ) : (
              <ChevronDown className="h-4 w-4" />
            )}
          </button>

          {expandedHyp ? (
            <div className={`${pad} pt-0 space-y-3`}>
              {!hypotheses.length ? (
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
                  Run checks to generate hypotheses.
                </div>
              ) : null}

              {hypotheses.map((h) => (
                <div
                  key={h.id}
                  className="rounded-2xl border border-slate-200 bg-white shadow-sm p-3"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h4 className="font-semibold text-slate-900">
                          {h.title}
                        </h4>
                        <Pill
                          icon={
                            <Sparkles
                              className="h-3.5 w-3.5"
                              aria-hidden="true"
                            />
                          }
                        >
                          Confidence <ConfidenceBar value={h.confidence} />
                        </Pill>
                      </div>
                      {h.rationale ? (
                        <p className="mt-1 text-sm text-slate-700">
                          {h.rationale}
                        </p>
                      ) : null}
                    </div>
                  </div>

                  {Array.isArray(h.nextActions) && h.nextActions.length ? (
                    <div className="mt-3">
                      <span className="text-xs font-medium text-slate-700">
                        Next actions
                      </span>
                      <ul className="mt-1 list-disc pl-5 text-sm text-slate-800 space-y-1">
                        {h.nextActions.map((a, idx) => (
                          <li key={`${idx}-${a.slice(0, 18)}`}>{a}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {Array.isArray(h.sources) && h.sources.length ? (
                    <div className="mt-3">
                      <span className="text-xs font-medium text-slate-700">
                        Sources
                      </span>
                      <ul className="mt-1 space-y-2">
                        {h.sources.map((s, idx) => {
                          const label = normalizeStr(s?.label) || "Source";
                          const url = safeUrl(s?.url);
                          return (
                            <li
                              key={`${idx}-${label}`}
                              className="flex items-center justify-between gap-3 rounded-xl bg-slate-50 border border-slate-200 px-3 py-2"
                            >
                              <span className="min-w-0 truncate text-sm text-slate-800">
                                {label}
                              </span>
                              {url ? (
                                <a
                                  href={url}
                                  target="_blank"
                                  rel="noreferrer noopener"
                                  className="inline-flex items-center gap-1 text-sm font-medium text-slate-900 hover:underline"
                                >
                                  Open{" "}
                                  <ExternalLink
                                    className="h-4 w-4"
                                    aria-hidden="true"
                                  />
                                </a>
                              ) : null}
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ) : null}
                </div>
              ))}

              {/* Footer actions */}
              <div className="flex flex-wrap items-center gap-2 pt-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={saveSession}
                  className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50 disabled:opacity-50"
                >
                  <Save className="h-4 w-4" aria-hidden="true" />
                  Save
                </button>

                <button
                  type="button"
                  disabled={busy || status === "completed"}
                  onClick={completeSession}
                  className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
                >
                  <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                  Complete
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* Minimal footer note */}
      <p className="mt-3 text-xs text-slate-600">
        Tip: Save early, especially when troubleshooting safety-related issues.
        You can attach photos later via a notes/log module if you add one.
      </p>
    </div>
  );
}

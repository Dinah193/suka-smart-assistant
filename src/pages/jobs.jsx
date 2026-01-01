// src/pages/jobs.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import MyBookingsDashboard from "../components/jobs/MyBookingsDashboard";
import RecurringBookingForm from "../components/jobs/RecurringBookingForm";
import WorkerInterviewPanel from "../components/jobs/WorkerInterviewPanel";
import InterviewSchedulerModal from "../components/jobs/InterviewSchedulerModal";
import RecurringSessionManager from "../components/jobs/RecurringSessionManager";

import { automation } from "@/services/automation/runtime"; // background automations
import { makeGlobLoader } from "@/utils/dynImport";         // ✅ Vite-safe dynamic importer
import "../index.css";

/* -------------------------------------------------------------------------- */
/* Simple tabbed tools UI                                                     */
/* -------------------------------------------------------------------------- */
const jobTools = [
  { id: "dashboard", label: "My Bookings",            component: <MyBookingsDashboard /> },
  { id: "recurring", label: "Recurring Booking Form", component: <RecurringBookingForm /> },
  { id: "manager",   label: "Session Manager",        component: <RecurringSessionManager /> },
  { id: "interview", label: "Interview Panel",        component: <WorkerInterviewPanel /> },
  { id: "scheduler", label: "Schedule Interview",     component: <InterviewSchedulerModal /> },
];

const TAB_DEFAULT = "dashboard";

/* --------------------------------- Helpers -------------------------------- */
const debounce = (fn, ms = 400) => {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
};
const todayISO = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};
const fmtTime = (ts) => {
  if (!ts) return "—";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
};

/* -------------------- Vite-safe loader for agents ------------------------- */
const loadAgent = makeGlobLoader([
  "/src/agents/*.js",
  "/src/agents/**/*.js",
]);

/* -------------------------------------------------------------------------- */
/* Jobs Page                                                                  */
/* -------------------------------------------------------------------------- */
export default function JobsPage() {
  const [active, setActive] = useState(TAB_DEFAULT);

  // lightweight, user-friendly insights
  const [insights, setInsights] = useState({
    interviewsUpcoming: 0,
    confirmationsPending: 0,
    openConflicts: 0,
    autoOffers: 0,
    lastSchedulerRunAt: null,
  });
  const [upcoming, setUpcoming] = useState([]);   // next 5 interviews/sessions
  const [conflicts, setConflicts] = useState([]); // top conflicts
  const [activity, setActivity] = useState([]);   // recent events
  const [lastScheduleEvents, setLastScheduleEvents] = useState([]); // for ICS export
  const [showJSON, setShowJSON] = useState(false);

  // dev/diagnostic log remains available under toggle
  const [log, setLog] = useState({});
  const ranTodayRef = useRef({ weekly: "", interviews: "", recurring: "" });
  const mountedRef = useRef(false);

  /* ---------------------- Background Template/Agent calls ---------------------- */
  async function runTemplateSafe(templateId, payload = {}) {
    try {
      const res = await automation.runTemplate(templateId, payload);
      setLog((prev) => ({ ...(prev || {}), [templateId]: { ok: true, res, at: new Date().toISOString() } }));

      // harvest scheduler data for insights
      if (templateId === "jobs-weekly-scheduler" && res) {
        setInsights((x) => ({ ...x, lastSchedulerRunAt: Date.now() }));
        const evs = Array.isArray(res.events) ? res.events : (res.schedule?.events || []);
        if (Array.isArray(evs)) {
          setLastScheduleEvents(evs);
          // upcoming: interviews or sessions in next 14d
          const soon = evs
            .filter((e) => {
              const s = new Date(e.start || e.date || e.when || e.ts || e.time).getTime();
              return !Number.isNaN(s) && s >= Date.now() && s <= Date.now() + 14 * 86400000;
            })
            .sort((a, b) => new Date(a.start || a.date) - new Date(b.start || b.date))
            .slice(0, 5);
          setUpcoming(soon);
        }
        const conflictsArr = Array.isArray(res.conflicts) ? res.conflicts : [];
        setConflicts(conflictsArr.slice(0, 5));
        setInsights((x) => ({ ...x, openConflicts: conflictsArr.length || 0 }));
      }

      if (templateId === "jobs-interview-pipeline" && res) {
        const upcomingCount = Number(res.upcomingCount ?? res.interviewsUpcoming ?? 0);
        const pending = Number(res.confirmationsPending ?? res.pending ?? 0);
        setInsights((x) => ({
          ...x,
          interviewsUpcoming: upcomingCount,
          confirmationsPending: pending,
        }));
        if (Array.isArray(res.upcoming)) {
          setUpcoming((prev) => {
            const merged = [...res.upcoming, ...prev];
            const uniq = new Map();
            merged.forEach((it) => uniq.set(it.id || `${it.title}-${it.start}`, it));
            return Array.from(uniq.values()).slice(0, 5);
          });
        }
      }

      if (templateId === "jobs-offer-and-billing" && res) {
        const offers = Number(res.offersCreated ?? res.autoOffers ?? 0);
        setInsights((x) => ({ ...x, autoOffers: (x.autoOffers || 0) + offers }));
      }

      return res;
    } catch (e) {
      setLog((prev) => ({ ...(prev || {}), [templateId]: { error: e?.message || String(e), at: new Date().toISOString() } }));
      return null;
    }
  }

  async function runAgentSafe(agentId, command, payload = {}) {
    try {
      const agent = await loadAgent([
        `@/agents/${agentId}.js`,
        `@/agents/${agentId}/index.js`,
        `src/agents/${agentId}.js`,
        `src/agents/${agentId}/index.js`,
      ]);
      if (!agent) throw new Error(`agent_not_found: ${agentId}`);

      const fn = agent?.default?.handleCommand || agent?.handleCommand;
      const res = typeof fn === "function" ? await fn(command, payload) : null;
      setLog((prev) => ({ ...(prev || {}), [`${agentId}:${command}`]: { ok: true, res, at: new Date().toISOString() } }));
      return res;
    } catch (e) {
      setLog((prev) => ({ ...(prev || {}), [`${agentId}:${command}`]: { error: e?.message || String(e), at: new Date().toISOString() } }));
      return null;
    }
  }

  /* ---------------------------- Daily auto routines ---------------------------- */
  useEffect(() => {
    const doDaily = async () => {
      const today = todayISO();

      if (ranTodayRef.current.weekly !== today) {
        await runTemplateSafe("jobs-weekly-scheduler", { invokedBy: "jobs:auto/daily" });
        ranTodayRef.current.weekly = today;
      }
      if (ranTodayRef.current.interviews !== today) {
        await runTemplateSafe("jobs-interview-pipeline", { invokedBy: "jobs:auto/daily" });
        ranTodayRef.current.interviews = today;
      }
      if (ranTodayRef.current.recurring !== today) {
        await runTemplateSafe("jobs-recurring-maintenance", { invokedBy: "jobs:auto/daily" });
        ranTodayRef.current.recurring = today;
      }
    };
    doDaily();
  }, []);

  /* ------------------ React to runtime signals (no manual UI) ------------------ */
  useEffect(() => {
    if (mountedRef.current) return;
    mountedRef.current = true;
    if (typeof automation?.on !== "function") return;

    const debounced = debounce(async (topic, payload) => {
      switch (true) {
        case topic.startsWith("jobs/recurring_created"):
        case topic.startsWith("jobs/recurring_updated"):
        case topic.startsWith("jobs/recurring_deleted"):
          await runTemplateSafe("jobs-recurring-maintenance", { invokedBy: topic, payload });
          await runTemplateSafe("jobs-weekly-scheduler", { invokedBy: topic, payload });
          break;

        case topic.startsWith("jobs/availability_updated"):
          await runTemplateSafe("jobs-availability-sync", { invokedBy: topic, payload });
          await runTemplateSafe("jobs-interview-pipeline", { invokedBy: topic, payload });
          break;

        case topic.startsWith("jobs/interview_requested"):
        case topic.startsWith("jobs/interview_reschedule"):
        case topic.startsWith("jobs/interview_cancelled"):
          await runTemplateSafe("jobs-interview-pipeline", { invokedBy: topic, payload });
          break;

        case topic.startsWith("jobs/booking_created"):
        case topic.startsWith("jobs/booking_updated"):
        case topic.startsWith("jobs/booking_cancelled"):
          await runTemplateSafe("jobs-weekly-scheduler", { invokedBy: topic, payload });
          break;

        case topic.startsWith("jobs/billing_updated"):
        case topic.startsWith("jobs/rate_policy_updated"):
          await runTemplateSafe("jobs-offer-and-billing", { invokedBy: topic, payload });
          break;

        default:
          break;
      }
    }, 500);

    const offs = [];
    const on = (evt, fn) => {
      const off = automation.on(evt, fn);
      offs.push(off);
    };

    on("jobs/recurring_created",  (p) => debounced("jobs/recurring_created", p));
    on("jobs/recurring_updated",  (p) => debounced("jobs/recurring_updated", p));
    on("jobs/recurring_deleted",  (p) => debounced("jobs/recurring_deleted", p));

    on("jobs/availability_updated", (p) => debounced("jobs/availability_updated", p));

    on("jobs/interview_requested",  (p) => debounced("jobs/interview_requested", p));
    on("jobs/interview_reschedule", (p) => debounced("jobs/interview_reschedule", p));
    on("jobs/interview_cancelled",  (p) => debounced("jobs/interview_cancelled", p));

    on("jobs/booking_created",   (p) => debounced("jobs/booking_created", p));
    on("jobs/booking_updated",   (p) => debounced("jobs/booking_updated", p));
    on("jobs/booking_cancelled", (p) => debounced("jobs/booking_cancelled", p));

    on("jobs/billing_updated",     (p) => debounced("jobs/billing_updated", p));
    on("jobs/rate_policy_updated", (p) => debounced("jobs/rate_policy_updated", p));

    // Activity feed from runtime
    const pushActivity = (evt) => {
      const topic = evt?.topic || evt?.type || "";
      let icon = "🛈";
      if (topic.includes("interview")) icon = "🗓️";
      else if (topic.includes("booking")) icon = "📌";
      else if (topic.includes("recurring")) icon = "♻️";
      else if (topic.includes("conflict")) icon = "⚠️";
      else if (topic.includes("offer") || topic.includes("billing")) icon = "💸";
      setActivity((prev) => [{ ts: evt.ts || Date.now(), icon, text: topic }, ...prev].slice(0, 8));
    };
    const offEvent = automation.on("event", pushActivity);
    const offRuntime = automation.on("runtime", pushActivity);
    offs.push(offEvent, offRuntime);

    return () => { offs.forEach((off) => { try { off?.(); } catch {} }); };
  }, []);

  /* -------------------------- Optional: agent assist -------------------------- */
  useEffect(() => {
    const runLightweight = async () => {
      await runAgentSafe("jobsAgent", "suggestFillIns", { horizonDays: 14, invokedBy: "jobs:auto/light" });
    };
    runLightweight();
  }, []);

  /* ------------------------------- Quick actions ------------------------------ */
  const exportICS = () => {
    if (!Array.isArray(lastScheduleEvents) || lastScheduleEvents.length === 0) return;
    const pad = (n) => String(n).padStart(2, "0");
    const dt = (d) => {
      const date = new Date(d);
      return (
        date.getUTCFullYear() +
        pad(date.getUTCMonth() + 1) +
        pad(date.getUTCDate()) + "T" +
        pad(date.getUTCHours()) + pad(date.getUTCMinutes()) + "00Z"
      );
    };
    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Suka//Jobs//EN",
      "X-WR-CALNAME:Suka Jobs",
      ...lastScheduleEvents.map((e, i) => {
        const id = e.id || `jobs-${i}-${Date.now()}`;
        const start = e.start || e.when || e.date;
        const end = e.end || e.until || start;
        const title = (e.title || e.name || e.role || "Job").toString().replace(/\n/g, " ");
        return [
          "BEGIN:VEVENT",
          `UID:${id}@suka`,
          `DTSTAMP:${dt(new Date())}`,
          `DTSTART:${dt(start)}`,
          `DTEND:${dt(end)}`,
          `SUMMARY:${title}`,
          "END:VEVENT",
        ].join("\n");
      }),
      "END:VCALENDAR",
    ].join("\n");

    const blob = new Blob([lines], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.download = "suka-jobs.ics";
    a.href = url;
    a.click();
    URL.revokeObjectURL(url);
  };

  const runHealthCheck = async () => {
    await runTemplateSafe("jobs-health-check", { invokedBy: "jobs:quick/health" });
  };

  /* --------------------------------- Layout --------------------------------- */
  const Tabs = useMemo(() => {
    return (
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
        {jobTools.map((t) => (
          <button
            key={t.id}
            className={`btn sm ${active === t.id ? "primary" : ""}`}
            onClick={() => setActive(t.id)}
          >
            <span className="label">{t.label}</span>
          </button>
        ))}
        <button className="btn sm" onClick={() => runTemplateSafe("jobs-weekly-scheduler", { invokedBy: "jobs:manual/scheduler" })}>🔄 Rebuild Schedule</button>
        <button className="btn sm" onClick={exportICS} disabled={!lastScheduleEvents.length}>📤 Export .ics</button>
        <button className="btn sm" onClick={runHealthCheck}>🩺 Health Check</button>
      </div>
    );
  }, [active, lastScheduleEvents.length]);

  const ActivePane = useMemo(() => {
    const item = jobTools.find((t) => t.id === active) || jobTools[0];
    return <div className="card">{item.component}</div>;
  }, [active]);

  return (
    <div>
      <h1>🧰 Jobs</h1>
      <p className="subtitle">
        Bookings, recurring sessions, and interview scheduling. Automations run in the background based on your actions—no manual triggers needed.
      </p>

      {Tabs}
      {ActivePane}

      {/* ------------------------ Jobs Insights (human-readable) ------------------------ */}
      <div className="card" style={{ marginTop: 16 }}>
        <div className="flex" style={{ gap: 12, flexWrap: "wrap" }}>
          <KpiCard title="Upcoming Interviews" value={insights.interviewsUpcoming} tone={insights.interviewsUpcoming > 0 ? "ok" : "muted"} hint="Next 2 weeks" />
          <KpiCard title="Pending Confirmations" value={insights.confirmationsPending} tone={insights.confirmationsPending > 0 ? "warn" : "ok"} hint="Awaiting response" />
          <KpiCard title="Open Conflicts" value={insights.openConflicts} tone={insights.openConflicts > 0 ? "warn" : "ok"} hint="Resolve schedule overlaps" />
          <KpiCard title="Auto Offers" value={insights.autoOffers} tone="muted" hint="Generated this session" />
          <KpiCard title="Last Scheduler Run" value={fmtTime(insights.lastSchedulerRunAt)} tone="muted" hint="jobs-weekly-scheduler" />
        </div>

        {/* Upcoming items */}
        <SectionTitle>Coming Up</SectionTitle>
        {upcoming.length === 0 ? (
          <div className="subtitle" style={{ opacity: 0.8 }}>Nothing on the horizon.</div>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {upcoming.slice(0, 5).map((it, i) => {
              const title = it.title || it.name || it.role || "Session";
              const dt = new Date(it.start || it.when || it.date);
              const loc = it.location || it.channel || it.mode || "";
              return (
                <RowCard key={String(it.id || i)} right={<span className="subtitle">{dt.toLocaleString()}</span>}>
                  <div style={{ fontWeight: 600 }}>{title}</div>
                  <div className="subtitle" style={{ fontSize: ".85rem" }}>
                    {it.type || it.kind || "Booking"} {loc ? `• ${loc}` : ""}
                  </div>
                </RowCard>
              );
            })}
          </div>
        )}

        {/* Conflicts */}
        <SectionTitle>Conflicts</SectionTitle>
        {conflicts.length === 0 ? (
          <div className="subtitle" style={{ opacity: 0.8 }}>No conflicts detected.</div>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {conflicts.map((c, i) => (
              <RowCard key={String(c.id || i)} tone="warn" right={<strong>⚠️</strong>}>
                <div style={{ fontWeight: 600 }}>{c.title || "Conflict"}</div>
                <div className="subtitle" style={{ fontSize: ".85rem" }}>
                  {c.reason || c.detail || "Overlap detected"} {c.window ? `• ${c.window}` : ""}
                </div>
              </RowCard>
            ))}
          </div>
        )}

        {/* Activity timeline */}
        <SectionTitle>Recent Activity</SectionTitle>
        {activity.length === 0 ? (
          <div className="subtitle" style={{ opacity: 0.8 }}>No recent activity yet.</div>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 6 }}>
            {activity.map((a, idx) => (
              <li key={idx} className="flex" style={{ gap: 8, alignItems: "center" }}>
                <span style={{ width: 22, textAlign: "center" }}>{a.icon}</span>
                <span style={{ fontSize: ".95rem" }}>{a.text}</span>
                <span className="subtitle" style={{ marginLeft: "auto" }}>{fmtTime(a.ts)}</span>
              </li>
            ))}
          </ul>
        )}

        {/* Toggleable raw JSON for debugging */}
        <div className="flex" style={{ gap: 8, marginTop: 12, alignItems: "center" }}>
          <button className="btn sm" onClick={() => setShowJSON((v) => !v)}>{showJSON ? "Hide" : "Show"} Raw Log</button>
          <span className="subtitle">Developer view</span>
        </div>
        {showJSON && (
          <pre className="card" style={{ marginTop: 8, whiteSpace: "pre-wrap", background: "#fafafa" }}>
            {JSON.stringify(log, null, 2)}
          </pre>
        )}
      </div>
      {/* -------------------------------------------------------------------------------- */}
    </div>
  );
}

/* ----------------------------- Tiny UI atoms ------------------------------ */
function KpiCard({ title, value, hint, tone = "muted" }) {
  const tones = {
    ok:    { bg: "rgba(16,185,129,.10)", border: "rgba(16,185,129,.35)" },
    warn:  { bg: "rgba(245,158,11,.10)", border: "rgba(245,158,11,.35)" },
    muted: { bg: "rgba(107,114,128,.08)", border: "rgba(107,114,128,.25)" },
  };
  const t = tones[tone] || tones.muted;
  return (
    <div className="card" style={{ minWidth: 200, background: t.bg, borderColor: t.border, borderWidth: 1, padding: 12 }}>
      <div className="subtitle" style={{ fontWeight: 700 }}>{title}</div>
      <div style={{ fontSize: "1.35rem", fontWeight: 800, lineHeight: 1.2 }}>{value}</div>
      <div className="subtitle" style={{ opacity: .85 }}>{hint}</div>
    </div>
  );
}
function SectionTitle({ children }) {
  return <div className="subtitle" style={{ marginTop: 14, fontWeight: 700 }}>{children}</div>;
}
function RowCard({ children, right, tone = "muted" }) {
  const border = tone === "warn" ? "rgba(245,158,11,.35)" : "var(--line)";
  const bg = tone === "warn" ? "rgba(245,158,11,.08)" : "#fff";
  return (
    <div className="flex" style={{ alignItems: "center", justifyContent: "space-between", gap: 10, border: `1px solid ${border}`, borderRadius: 12, padding: "8px 10px", background: bg }}>
      <div>{children}</div>
      {right ? <div>{right}</div> : null}
    </div>
  );
}

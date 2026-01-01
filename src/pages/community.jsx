// src/pages/community.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  getSharedPlans,
  saveSharedPlan,
  getGardenPlans,
  saveGardenPlan,
  getAnimalPlans,
  saveAnimalPlan,
} from "../utils/syncStorage";

import { automation } from "@/services/automation/runtime";
import "../index.css";

/* ----------------------------- utils ----------------------------- */
function useDebounce(cb, delay = 700) {
  const t = useRef(null);
  return (...args) => {
    if (t.current) clearTimeout(t.current);
    t.current = setTimeout(() => cb(...args), delay);
  };
}
const isoDate = () =>
  new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 10);

const fmtDate = (d) => {
  if (!d) return "";
  try {
    const dt = new Date(d);
    if (!isNaN(dt)) return dt.toLocaleDateString();
  } catch {}
  return String(d).slice(0, 10);
};

const LS_SESSIONS_KEY = "communitySessions";
const LS_TOPICSETS_KEY = "communityTopicSets";

/* ----------------------------- page ------------------------------ */
export default function CommunityPage() {
  const [activeTab, setActiveTab] = useState("cook");

  // Local stores
  const [sharedPlans, setSharedPlans] = useState([]);
  const [gardenPlots, setGardenPlots] = useState([]);
  const [animalPlans, setAnimalPlans] = useState([]);

  // Inputs that retrigger agents in background
  const [roomPrefs, setRoomPrefs] = useState({
    availability: { days: ["Sat", "Sun"], start: "10:00", end: "12:00" },
    maxParticipants: 8,
    privacy: "friends", // public | friends | invite
  });

  const [gardenForm, setGardenForm] = useState({
    zone: "8a",
    beds: 4,
    sqftPerBed: 32,
    preferredCrops: ["tomatoes", "beans", "greens"],
    sharePolicy: "swap",
  });

  const [animalForm, setAnimalForm] = useState({
    landAcres: 0.5,
    feedCapacityMonthlyLbs: 400,
    species: {
      chickens: 8,
      ducks: 0,
      rabbits: 0,
      goats: 2,
      sheep: 0,
      pigs: 0,
    },
    purposes: ["eggs", "milk"],
    sharePolicy: "swap",
  });

  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState(false);
  const [lastOutput, setLastOutput] = useState(null);

  /* ---------------------- load per-tab data ---------------------- */
  useEffect(() => {
    if (activeTab === "shared") {
      setSharedPlans(getSharedPlans("user_123"));
    } else if (activeTab === "garden") {
      setGardenPlots(getGardenPlans());
    } else if (activeTab === "animals") {
      setAnimalPlans(getAnimalPlans());
    }
  }, [activeTab]);

  /* ---------------------- background automations ---------------------- */
  const runGardenAgents = useDebounce(async (state) => {
    try {
      const ctx = {
        invokedBy: "ui/community",
        garden: state.gardenForm,
        known: { plots: gardenPlots },
      };
      const cal = await automation.runTemplate(
        "seasonal-planting-calendar-generator",
        ctx
      );
      const layout = await automation.runTemplate(
        "companion-plant-layout-builder",
        ctx
      );
      const scout = await automation.runTemplate("pest-disease-scout", ctx);
      const preserve = await automation.runTemplate(
        "harvest-preservation-sync",
        ctx
      );
      setLastOutput((o) => ({
        ...(o || {}),
        date: new Date().toISOString(),
        garden: { cal, layout, scout, preserve },
      }));
    } catch {}
  });

  const runAnimalAgents = useDebounce(async (state) => {
    try {
      const ctx = {
        invokedBy: "ui/community",
        animals: state.animalForm,
        known: { plans: animalPlans },
      };
      const breed = await automation.runTemplate("breeding-cycle-planner", ctx);
      const feed = await automation.runTemplate("daily-feed-rotation", ctx);
      const manure = await automation.runTemplate(
        "manure-to-compost-cycle",
        ctx
      );
      const soil = await automation.runTemplate(
        "soil-water-health-keeper",
        ctx
      );
      setLastOutput((o) => ({
        ...(o || {}),
        date: new Date().toISOString(),
        animals: { breed, feed, manure, soil },
      }));
    } catch {}
  });

  // Auto-run when forms change on their tabs
  useEffect(() => {
    if (activeTab === "garden") runGardenAgents({ gardenForm });
  }, [activeTab, gardenForm]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (activeTab === "animals") runAnimalAgents({ animalForm });
  }, [activeTab, animalForm]); // eslint-disable-line react-hooks/exhaustive-deps

  /* --------------------------- actions --------------------------- */
  const startRoom = async (kind /* "cook" | "clean" */) => {
    setBusy(true);
    setOk(false);
    setLastOutput(null);
    const ctx = {
      kind,
      createdBy: "user_123",
      ts: Date.now(),
      roomPrefs,
    };
    try {
      const res = await automation.runTemplate("community.room.start", ctx);
      trySaveSessionFromResponse(kind, res);
      setLastOutput({ date: new Date().toISOString(), room: { [kind]: res } });
    } catch (e) {
      automation.emit("event", { type: "community/room_start", payload: ctx });
      setLastOutput({
        date: new Date().toISOString(),
        room: { [kind]: { via: "event", emitted: true } },
      });
    } finally {
      setBusy(false);
      setOk(true);
      setTimeout(() => setOk(false), 900);
    }
  };

  const syncCommunity = async () => {
    setBusy(true);
    setOk(false);
    try {
      const res = await automation.runTemplate("community.sync", {
        invokedBy: "ui/community",
        known: { sharedPlans, gardenPlots, animalPlans },
      });
      if (Array.isArray(res?.sharedPlans)) setSharedPlans(res.sharedPlans);
      if (Array.isArray(res?.gardenPlots)) setGardenPlots(res.gardenPlots);
      if (Array.isArray(res?.animalPlans)) setAnimalPlans(res.animalPlans);
      setLastOutput((o) => ({
        ...(o || {}),
        date: new Date().toISOString(),
        sync: res,
      }));
    } catch (e) {
      automation.emit("event", {
        type: "community/sync_request",
        payload: { known: { sharedPlans, gardenPlots, animalPlans } },
      });
      setLastOutput((o) => ({
        ...(o || {}),
        date: new Date().toISOString(),
        sync: { via: "event", emitted: true },
      }));
    } finally {
      setBusy(false);
      setOk(true);
      setTimeout(() => setOk(false), 900);
    }
  };

  const handleAddGardenPlot = () => {
    const newPlot = {
      id: Date.now(),
      ownerId: "user_123",
      crop: "Tomatoes",
      location: "Backyard Plot",
      meta: gardenForm,
    };
    saveGardenPlan(newPlot);
    setGardenPlots((p) => [...p, newPlot]);
  };

  const handleAddAnimalPlan = () => {
    const newPlan = {
      id: Date.now(),
      ownerId: "user_123",
      animal: "Goats",
      purpose: "Milk",
      meta: animalForm,
    };
    saveAnimalPlan(newPlan);
    setAnimalPlans((p) => [...p, newPlan]);
  };

  /* --------------------------- Studio + Sessions --------------------------- */
  const [studio, setStudio] = useState({
    enabled: false,
    mode: "cook", // cook | clean | garden
    title: "Cook With Me: Freezer Basics",
    subtitle: `Recorded ${isoDate()}`,
    script:
      "Welcome! Today we're batch cooking basics for the week. Grab cutting boards, label your containers, and let's roll!",
    // Session Topics (in-depth, women-centered, biblical + non-biblical empowerment)
    sessionTopics: [
      "Zephaniah 3:10 — Women bringing the offering: historical context and modern application",
      "Ensuring women have non-servile self-care hobbies (creative disciplines that restore the spirit)",
      "Women in Yah’s covenant beyond domestic roles — identity, purpose, and community impact",
      "Challenging generational traditions that contradict Torah — discernment vs. conformity",
      "Leadership as service: women setting righteous culture in households and assemblies",
      "Justice and mercy: women’s role in advocacy, care for the vulnerable, and community repair",
      "Building sisterhood: moving from isolation to accountable, life-giving relationships",
    ],
    checklist: [
      "Intro & safety",
      "Ingredient overview",
      "Step 1",
      "Step 2",
      "Plating & wrap-up",
    ],
    sceneIndex: 0,
    recording: false,
    paused: false,
    timerSec: 0,
    overlays: { lowerThird: true, emojiBursts: true, gridGuide: false },
  });

  // Saved sessions (local)
  const [sessions, setSessions] = useState(() => {
    try {
      const raw = localStorage.getItem(LS_SESSIONS_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });
  const [selectedSessionId, setSelectedSessionId] = useState("");

  // Topic Sets (named reusable sets)
  const [topicSets, setTopicSets] = useState(() => {
    try {
      const raw = localStorage.getItem(LS_TOPICSETS_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });
  const [selectedTopicSetId, setSelectedTopicSetId] = useState("");
  const [newTopicSetName, setNewTopicSetName] = useState("");

  const scriptFileInputRef = useRef(null);
  const topicsFileInputRef = useRef(null);

  // timer
  useEffect(() => {
    if (!studio.recording || studio.paused) return;
    const t = setInterval(() => {
      setStudio((s) => ({ ...s, timerSec: s.timerSec + 1 }));
    }, 1000);
    return () => clearInterval(t);
  }, [studio.recording, studio.paused]);

  const startRecording = () => {
    setStudio((s) => ({ ...s, recording: true, paused: false, timerSec: 0 }));
    try {
      automation?.emit?.("recording/start", { from: "community", mode: studio.mode });
    } catch {}
  };
  const pauseRecording = () => {
    setStudio((s) => ({ ...s, paused: !s.paused }));
    try {
      automation?.emit?.("recording/toggle_pause", { paused: !studio.paused });
    } catch {}
  };
  const stopRecording = () => {
    setStudio((s) => ({ ...s, recording: false, paused: false }));
    try {
      automation?.emit?.("recording/stop", { durationSec: studio.timerSec });
    } catch {}
  };

  const nextScene = () =>
    setStudio((s) => ({
      ...s,
      sceneIndex: Math.min(s.sceneIndex + 1, s.checklist.length - 1),
    }));
  const prevScene = () =>
    setStudio((s) => ({ ...s, sceneIndex: Math.max(0, s.sceneIndex - 1) }));
  const toggleOverlay = (k) =>
    setStudio((s) => ({ ...s, overlays: { ...s.overlays, [k]: !s.overlays[k] } }));

  /* ---------- sessions: save/load/import/export + pull from automation ---------- */
  const persistSessions = (arr) => {
    setSessions(arr);
    try {
      localStorage.setItem(LS_SESSIONS_KEY, JSON.stringify(arr));
    } catch {}
  };

  const saveCurrentAsSession = () => {
    const entry = {
      id: String(Date.now()),
      mode: studio.mode,
      title: studio.title || `${studio.mode} session`,
      subtitle: studio.subtitle,
      script: studio.script || "",
      sessionTopics: studio.sessionTopics || [],
      checklist: studio.checklist || [],
      createdAt: new Date().toISOString(),
    };
    const arr = [entry, ...sessions].slice(0, 50);
    persistSessions(arr);
    setSelectedSessionId(entry.id);
    setOk(true);
    setTimeout(() => setOk(false), 900);
  };

  const loadSession = (id) => {
    const s = sessions.find((x) => x.id === id);
    if (!s) return;
    setStudio((prev) => ({
      ...prev,
      enabled: true,
      mode: s.mode || prev.mode,
      title: s.title || prev.title,
      subtitle: s.subtitle || prev.subtitle,
      script: s.script ?? prev.script,
      sessionTopics:
        Array.isArray(s.sessionTopics) && s.sessionTopics.length
          ? s.sessionTopics
          : prev.sessionTopics,
      checklist:
        Array.isArray(s.checklist) && s.checklist.length ? s.checklist : prev.checklist,
      sceneIndex: 0,
    }));
  };

  const trySaveSessionFromResponse = (mode, res) => {
    if (!res || typeof res !== "object") return;
    const session = res.session || res.room || res.data || res.result || res;
    const title =
      session?.title || session?.name || session?.sessionTitle || `${mode} session`;
    const subtitle =
      session?.subtitle || session?.description || session?.note || `Recorded ${isoDate()}`;
    const script =
      session?.script || session?.teleprompter || session?.notes || session?.content || "";
    const checklist = session?.checklist || session?.steps || session?.segments || [];
    const topics =
      session?.topics || session?.sessionTopics || session?.discussion || [];

    if (script || (Array.isArray(checklist) && checklist.length) || title || topics?.length) {
      const entry = {
        id: String(Date.now()),
        mode,
        title,
        subtitle,
        script,
        checklist,
        sessionTopics: Array.isArray(topics) ? topics : [],
        createdAt: new Date().toISOString(),
      };
      persistSessions([entry, ...sessions].slice(0, 50));
      setSelectedSessionId(entry.id);
    }
  };

  const pullLatestSession = async () => {
    setBusy(true);
    try {
      const ctx = { invokedBy: "ui/community", mode: studio.mode };
      let res = null;
      const candidates = [
        "community.room.current",
        "community.room.latest",
        "community.room.get",
      ];
      for (const id of candidates) {
        try {
          // eslint-disable-next-line no-await-in-loop
          res = await automation.runTemplate(id, ctx);
          if (res) break;
        } catch {}
      }
      if (res) {
        trySaveSessionFromResponse(studio.mode, res);
        const session = res.session || res.room || res.data || res.result || res;
        setStudio((prev) => ({
          ...prev,
          enabled: true,
          title: session?.title || session?.name || session?.sessionTitle || prev.title,
          subtitle: session?.subtitle || session?.description || session?.note || prev.subtitle,
          script:
            session?.script ||
            session?.teleprompter ||
            session?.notes ||
            session?.content ||
            prev.script,
          sessionTopics:
            session?.topics || session?.sessionTopics || session?.discussion || prev.sessionTopics,
          checklist: session?.checklist || session?.steps || session?.segments || prev.checklist,
          sceneIndex: 0,
        }));
      } else {
        alert("No session found from automation.");
      }
    } finally {
      setBusy(false);
    }
  };

  /* --------------------------- Topic Sets --------------------------- */
  const persistTopicSets = (arr) => {
    setTopicSets(arr);
    try {
      localStorage.setItem(LS_TOPICSETS_KEY, JSON.stringify(arr));
    } catch {}
  };

  const saveTopicSet = () => {
    const name = newTopicSetName.trim() || `[${studio.mode}] ${studio.title}`;
    const entry = {
      id: String(Date.now()),
      name,
      mode: studio.mode,
      topics: studio.sessionTopics.slice(),
      createdAt: new Date().toISOString(),
    };
    persistTopicSets([entry, ...topicSets].slice(0, 100));
    setSelectedTopicSetId(entry.id);
    setNewTopicSetName("");
    setOk(true);
    setTimeout(() => setOk(false), 900);
  };

  const loadTopicSet = (id) => {
    const t = topicSets.find((x) => x.id === id);
    if (!t) return;
    setStudio((s) => ({ ...s, sessionTopics: Array.isArray(t.topics) ? t.topics.slice() : [] }));
  };

  const deleteTopicSet = (id) => {
    persistTopicSets(topicSets.filter((x) => x.id !== id));
    if (selectedTopicSetId === id) setSelectedTopicSetId("");
  };

  const shuffleTopics = () => {
    setStudio((s) => {
      const arr = s.sessionTopics.slice();
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return { ...s, sessionTopics: arr };
    });
  };

  const generateTopics = async () => {
    setBusy(true);
    try {
      // Ask automation first
      const res = await automation.runTemplate("session-topics.generate", {
        invokedBy: "ui/community",
        mode: studio.mode, // cook | clean | garden
        focus: "women_in_yah_and_empowerment",
        depth: "in-depth",
        seedExamples: [
          "Zephaniah 3:10 — Women bringing the offering: historical context and modern application",
          "Ensuring women have non-servile self-care hobbies",
        ],
      });

      const candidates =
        (Array.isArray(res?.topics) && res.topics) ||
        (Array.isArray(res?.sessionTopics) && res.sessionTopics) ||
        (Array.isArray(res) && res) ||
        null;

      if (candidates && candidates.length) {
        setStudio((s) => ({ ...s, sessionTopics: candidates.slice(0, 20) }));
      } else {
        // Fallback: curated seeds if automation returns nothing
        setStudio((s) => ({
          ...s,
          sessionTopics: [
            "Zephaniah 3:10 — Women bringing the offering: historical context and modern application",
            "Deconstructing servility: how to reject cultural scripts while embracing holiness",
            "Women’s agency in economic life — Proverbs, Acts, and modern entrepreneurship",
            "Rest as resistance: Sabbath, Jubilee, and women’s mental health",
            "Creative disciplines as worship: music, writing, craft, and the making of meaning",
            "Calling and gifts: discerning assignments in seasons of waiting vs. action",
            "Community repair: hospitality, justice, advocacy, and mutual aid led by women",
            "Navigating authority structures without erasing voice or conscience",
            "Training daughters and mentoring sisters: models that produce freedom + responsibility",
            "Prayer that changes culture: intercession, lament, and prophetic imagination",
          ],
        }));
      }
    } catch {
      // Hard fallback if call fails
      setStudio((s) => ({
        ...s,
        sessionTopics: [
          "Zephaniah 3:10 — Women bringing the offering: historical context and modern application",
          "Deconstructing servility: how to reject cultural scripts while embracing holiness",
          "Women’s agency in economic life — Proverbs, Acts, and modern entrepreneurship",
          "Rest as resistance: Sabbath, Jubilee, and women’s mental health",
          "Creative disciplines as worship: music, writing, craft, and the making of meaning",
          "Calling and gifts: discerning assignments in seasons of waiting vs. action",
          "Community repair: hospitality, justice, advocacy, and mutual aid led by women",
          "Navigating authority structures without erasing voice or conscience",
          "Training daughters and mentoring sisters: models that produce freedom + responsibility",
          "Prayer that changes culture: intercession, lament, and prophetic imagination",
        ],
      }));
    } finally {
      setBusy(false);
    }
  };

  /* --------------------------- import/export helpers --------------------------- */
  const clickUploadScript = () => scriptFileInputRef.current?.click();
  const clickUploadTopics = () => topicsFileInputRef.current?.click();

  const onImportScript = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      setStudio((s) => ({ ...s, script: text || "" }));
      setOk(true);
      setTimeout(() => setOk(false), 900);
    } catch (err) {
      alert("Could not read file.");
      console.error(err);
    } finally {
      e.target.value = "";
    }
  };

  const onImportTopics = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const lines = text
        .split(/\r?\n/)
        .map((t) => t.trim())
        .filter(Boolean);
      if (lines.length) {
        setStudio((s) => ({ ...s, sessionTopics: lines }));
        setOk(true);
        setTimeout(() => setOk(false), 900);
      }
    } catch (err) {
      alert("Could not read topics file.");
      console.error(err);
    } finally {
      e.target.value = "";
    }
  };

  const exportScriptTxt = () => {
    try {
      const blob = new Blob([studio.script || ""], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(studio.title || "session").replace(/\s+/g, "_")}.txt`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error(e);
    }
  };

  const exportTopicsTxt = () => {
    try {
      const blob = new Blob([(studio.sessionTopics || []).join("\n")], {
        type: "text/plain",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(studio.title || "session_topics").replace(/\s+/g, "_")}.txt`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error(e);
    }
  };

  /* --------------------------- tabs --------------------------- */
  const tabs = [
    { key: "cook", label: "👩‍🍳 Cook With Me" },
    { key: "clean", label: "🧼 Clean With Me" },
    { key: "shared", label: "📥 Import Plans" },
    { key: "garden", label: "🌱 Garden Co-Op" },
    { key: "animals", label: "🐓 Animal Plans" },
  ];

  /* ----------------------- Live Studio component ----------------------- */
  const LiveStudio = ({ mode }) => {
    const scene = studio.checklist[studio.sceneIndex] || "";
    const mm = String(Math.floor(studio.timerSec / 60)).padStart(2, "0");
    const ss = String(studio.timerSec % 60).padStart(2, "0");

    return (
      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        {/* stage */}
        <div
          style={{
            position: "relative",
            background: "#0b1220",
            color: "white",
            minHeight: 360,
            borderBottom: "1px solid var(--line)",
          }}
        >
          {/* framing guide */}
          {studio.overlays.gridGuide && (
            <div
              aria-hidden
              style={{
                position: "absolute",
                inset: 0,
                background:
                  "linear-gradient(to right, rgba(255,255,255,.08) 1px, transparent 1px) 0 0/33.33% 100%, linear-gradient(to bottom, rgba(255,255,255,.08) 1px, transparent 1px) 0 0/100% 33.33%",
                pointerEvents: "none",
              }}
            />
          )}

          {/* lower third */}
          {studio.overlays.lowerThird && (
            <div
              style={{
                position: "absolute",
                left: 12,
                bottom: 12,
                background: "rgba(0,0,0,.45)",
                backdropFilter: "blur(6px)",
                border: "1px solid rgba(255,255,255,.18)",
                padding: "10px 14px",
                borderRadius: 14,
                boxShadow: "0 10px 30px rgba(0,0,0,.25)",
              }}
            >
              <div style={{ fontWeight: 700 }}>{studio.title}</div>
              <div className="subtitle" style={{ color: "#a3b2cc" }}>
                {studio.subtitle}
              </div>
            </div>
          )}

          {/* timer & scene pill */}
          <div
            style={{
              position: "absolute",
              right: 12,
              top: 12,
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <span
              className="badge"
              style={{
                background:
                  studio.recording && !studio.paused ? "#ef4444" : "#64748b",
                color: "white",
              }}
            >
              {studio.recording ? (studio.paused ? "PAUSED" : "REC") : "STANDBY"}
            </span>
            <span className="badge" style={{ background: "#111827", color: "white" }}>
              {mm}:{ss}
            </span>
          </div>

          {/* center cue + CURRENT TOPIC */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "grid",
              placeItems: "center",
              padding: 16,
              textAlign: "center",
            }}
          >
            <div>
              <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: 0.2 }}>
                {scene || "Ready?"}
              </div>
              <div style={{ marginTop: 6, color: "#a3b2cc" }}>
                {mode === "cook"
                  ? "Batch cooking together"
                  : mode === "clean"
                  ? "Sprint cleaning together"
                  : "Co-op harvest update"}
              </div>
              {studio.sessionTopics?.length ? (
                <div
                  style={{
                    marginTop: 10,
                    fontSize: 14,
                    color: "#fcd34d",
                    padding: "6px 10px",
                    background: "rgba(0,0,0,.35)",
                    display: "inline-block",
                    borderRadius: 10,
                  }}
                  title="Current Topic"
                >
                  Topic: {studio.sessionTopics[0]}
                </div>
              ) : null}
            </div>
          </div>

          {/* emoji bursts */}
          {studio.overlays.emojiBursts && studio.recording && !studio.paused && (
            <EmojiRain />
          )}
        </div>

        {/* controls & teleprompter & topics */}
        <div
          className="p-3"
          style={{
            display: "grid",
            gap: 12,
            gridTemplateColumns: "1.2fr .8fr",
            alignItems: "start",
          }}
        >
          {/* left: controls & scenes + sessions & topicsets */}
          <div className="rounded-xl border p-3 bg-white/70">
            <div className="flex items-center gap-2 flex-wrap">
              <button className="btn sm" onClick={prevScene}>
                ◀ Scene
              </button>
              <button className="btn sm" onClick={nextScene}>
                Scene ▶
              </button>
              <div style={{ flex: 1 }} />
              <button className="btn sm" onClick={() => toggleOverlay("lowerThird")}>
                Lower Third: {studio.overlays.lowerThird ? "On" : "Off"}
              </button>
              <button className="btn sm" onClick={() => toggleOverlay("emojiBursts")}>
                Reactions: {studio.overlays.emojiBursts ? "On" : "Off"}
              </button>
              <button className="btn sm" onClick={() => toggleOverlay("gridGuide")}>
                Grid: {studio.overlays.gridGuide ? "On" : "Off"}
              </button>
            </div>

            <div
              className="mt-3"
              style={{
                display: "grid",
                gap: 8,
                gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              }}
            >
              {studio.checklist.map((step, i) => (
                <label
                  key={i}
                  className="card"
                  style={{
                    padding: 8,
                    borderColor: i === studio.sceneIndex ? "#60a5fa" : "var(--line)",
                    background: i <= studio.sceneIndex ? "#eef6ff" : "white",
                  }}
                >
                  <div className="flex items-center gap-2">
                    <input type="checkbox" checked={i < studio.sceneIndex} readOnly />
                    <div className="text-sm">{step}</div>
                  </div>
                </label>
              ))}
            </div>

            <div className="mt-3 flex items-center gap-2">
              {!studio.recording ? (
                <button className="btn primary" onClick={startRecording}>
                  <span className="label">● Start Recording</span>
                </button>
              ) : (
                <>
                  <button className="btn" onClick={pauseRecording}>
                    <span className="label">{studio.paused ? "Resume" : "Pause"}</span>
                  </button>
                  <button className="btn" onClick={stopRecording}>
                    <span className="label">■ Stop</span>
                  </button>
                </>
              )}
              <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                <input
                  className="btn"
                  style={{ width: 280 }}
                  value={studio.title}
                  onChange={(e) => setStudio((s) => ({ ...s, title: e.target.value }))}
                  placeholder="Stream title"
                />
                <button className="btn sm" onClick={saveCurrentAsSession}>
                  Save Session
                </button>
              </div>
            </div>

            {/* Saved sessions */}
            <div className="mt-2 flex items-center gap-2 flex-wrap">
              <select
                className="btn"
                value={selectedSessionId}
                onChange={(e) => {
                  const id = e.target.value;
                  setSelectedSessionId(id);
                  if (id) loadSession(id);
                }}
                style={{ minWidth: 260 }}
              >
                <option value="">Load saved session…</option>
                {sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    [{s.mode}] {s.title} — {new Date(s.createdAt).toLocaleString()}
                  </option>
                ))}
              </select>
              <button className="btn sm" onClick={pullLatestSession} aria-busy={busy}>
                Pull Latest From Automation
              </button>
            </div>

            {/* Topic sets manager */}
            <div className="mt-3 rounded-xl border p-3 bg-white/80">
              <div className="text-sm font-medium mb-2">Reusable Topic Sets</div>
              <div className="flex items-center gap-2 flex-wrap">
                <input
                  className="btn"
                  style={{ width: 240 }}
                  placeholder="Name this topic set (e.g., Women in Yah)"
                  value={newTopicSetName}
                  onChange={(e) => setNewTopicSetName(e.target.value)}
                />
                <button className="btn xs" onClick={saveTopicSet}>Save Topic Set</button>

                <select
                  className="btn"
                  value={selectedTopicSetId}
                  onChange={(e) => setSelectedTopicSetId(e.target.value)}
                  style={{ minWidth: 220 }}
                >
                  <option value="">Load saved set…</option>
                  {topicSets.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} — {new Date(t.createdAt).toLocaleDateString()}
                    </option>
                  ))}
                </select>
                <button className="btn xs" onClick={() => selectedTopicSetId && loadTopicSet(selectedTopicSetId)}>
                  Load
                </button>
                <button
                  className="btn xs"
                  onClick={() => selectedTopicSetId && deleteTopicSet(selectedTopicSetId)}
                >
                  Delete
                </button>
              </div>
            </div>
          </div>

          {/* right: teleprompter + session topics */}
          <div className="rounded-xl border p-3 bg-white/70">
            {/* Teleprompter */}
            <div className="text-sm font-medium mb-1">Teleprompter</div>
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <button className="btn xs" onClick={clickUploadScript}>
                Upload .txt / .md
              </button>
              <button className="btn xs" onClick={exportScriptTxt}>
                Export .txt
              </button>
              <span className="subtitle">or type below…</span>
              <input
                ref={scriptFileInputRef}
                style={{ display: "none" }}
                type="file"
                accept=".txt,.md,text/plain"
                onChange={onImportScript}
              />
            </div>

            <textarea
              className="btn"
              style={{ width: "100%", height: 140, lineHeight: 1.5 }}
              value={studio.script}
              onChange={(e) => setStudio((s) => ({ ...s, script: e.target.value }))}
              placeholder="Paste or type your script here…"
            />
            <div
              className="mt-2 rounded-lg border p-2 bg-white text-sm"
              style={{ maxHeight: 120, overflow: "auto" }}
            >
              {studio.script}
            </div>

            {/* Session Topics */}
            <div className="text-sm font-medium mt-4 mb-1">Session Topics</div>
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <button className="btn xs" onClick={generateTopics} aria-busy={busy}>
                Generate Topics
              </button>
              <button className="btn xs" onClick={shuffleTopics}>
                Shuffle Order
              </button>
              <button className="btn xs" onClick={clickUploadTopics}>
                Upload .txt (one per line)
              </button>
              <button className="btn xs" onClick={exportTopicsTxt}>
                Export .txt
              </button>
              <input
                ref={topicsFileInputRef}
                style={{ display: "none" }}
                type="file"
                accept=".txt,text/plain"
                onChange={onImportTopics}
              />
            </div>

            <textarea
              className="btn"
              style={{ width: "100%", height: 140, lineHeight: 1.5 }}
              value={(studio.sessionTopics || []).join("\n")}
              onChange={(e) =>
                setStudio((s) => ({
                  ...s,
                  sessionTopics: e.target.value
                    .split(/\r?\n/)
                    .map((t) => t.trim())
                    .filter(Boolean),
                }))
              }
              placeholder="Add deep, meaningful topics here (one per line)…"
            />
            <div
              className="mt-2 rounded-lg border p-2 bg-white text-sm"
              style={{ maxHeight: 160, overflow: "auto" }}
            >
              <ul className="list-disc pl-5">
                {(studio.sessionTopics || []).map((t, i) => (
                  <li key={i}>{t}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>
    );
  };

  /* ------------------------ renderers ------------------------- */
  const renderContent = () => {
    switch (activeTab) {
      case "cook":
        return (
          <section className="card">
            <h2 style={{ marginTop: 0 }}>👩‍🍳 Cook With Me</h2>
            <p className="subtitle">Join or create a shared cooking session to stay motivated!</p>

            <RoomPrefsEditor roomPrefs={roomPrefs} setRoomPrefs={setRoomPrefs} />

            <div
              style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}
            >
              <button
                className="btn primary sm"
                aria-busy={busy}
                onClick={() => startRoom("cook")}
              >
                <span className="label">➕ Start Cooking Room</span>
              </button>
              <button
                className="btn sm"
                onClick={() => {
                  setStudio((s) => ({
                    ...s,
                    enabled: true,
                    mode: "cook",
                    title: "Cook With Me: Freezer Basics",
                  }));
                }}
              >
                <span className="label">🎬 Open Studio</span>
              </button>
              <button className="btn sm" onClick={syncCommunity}>
                <span className="label">Sync</span>
              </button>
              {ok ? (
                <span className="subtitle" style={{ color: "var(--success)" }}>
                  ✓ Updated
                </span>
              ) : null}
            </div>

            {studio.enabled && studio.mode === "cook" ? (
              <div className="mt-3">
                <LiveStudio mode="cook" />
              </div>
            ) : null}
          </section>
        );

      case "clean":
        return (
          <section className="card">
            <h2 style={{ marginTop: 0 }}>🧼 Clean With Me</h2>
            <p className="subtitle">Motivate each other by cleaning together in real-time.</p>

            <RoomPrefsEditor roomPrefs={roomPrefs} setRoomPrefs={setRoomPrefs} />

            <div
              style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}
            >
              <button
                className="btn primary sm"
                aria-busy={busy}
                onClick={() => startRoom("clean")}
              >
                <span className="label">➕ Start Cleaning Room</span>
              </button>
              <button
                className="btn sm"
                onClick={() =>
                  setStudio((s) => ({
                    ...s,
                    enabled: true,
                    mode: "clean",
                    title: "Clean With Me: Sprint",
                  }))
                }
              >
                <span className="label">🎬 Open Studio</span>
              </button>
              <button className="btn sm" onClick={syncCommunity}>
                <span className="label">Sync</span>
              </button>
              {ok ? (
                <span className="subtitle" style={{ color: "var(--success)" }}>
                  ✓ Updated
                </span>
              ) : null}
            </div>

            {studio.enabled && studio.mode === "clean" ? (
              <div className="mt-3">
                <LiveStudio mode="clean" />
              </div>
            ) : null}
          </section>
        );

      case "shared":
        return (
          <section className="card">
            <h2 style={{ marginTop: 0 }}>📥 Import Plans</h2>
            <p className="subtitle">
              Import cooking or cleaning plans from people you’re connected to.
            </p>

            <div className="card" style={{ background: "#fff", marginTop: 8 }}>
              {sharedPlans.length > 0 ? (
                <div style={{ display: "grid", gap: 8 }}>
                  {sharedPlans.map((plan) => (
                    <div
                      key={plan.id}
                      className="card"
                      style={{ background: "#fafafa" }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          gap: 8,
                        }}
                      >
                        <div>
                          <div style={{ fontWeight: 600 }}>{plan.title}</div>
                          <div className="subtitle" style={{ marginTop: 2 }}>
                            Type: {plan.type}
                          </div>
                        </div>
                        <button className="btn sm" onClick={() => saveSharedPlan(plan)}>
                          <span className="label">Import</span>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="subtitle">
                  No shared plans yet. Connect with others to see their plans.
                </p>
              )}
            </div>
          </section>
        );

      case "garden":
        return (
          <section className="card">
            <h2 style={{ marginTop: 0 }}>🌱 Garden Co-Op</h2>
            <p className="subtitle">Plan together so every participating household has enough.</p>

            <GardenFormEditor value={gardenForm} onChange={setGardenForm} />

            <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
              <button className="btn primary sm" onClick={handleAddGardenPlot}>
                <span className="label">➕ Add My Plot Plan</span>
              </button>
              <button
                className="btn sm"
                onClick={() =>
                  setStudio((s) => ({
                    ...s,
                    enabled: true,
                    mode: "garden",
                    title: "Co-Op Garden Update",
                  }))
                }
              >
                <span className="label">🎬 Open Studio</span>
              </button>
              <button className="btn sm" onClick={syncCommunity}>
                <span className="label">Sync</span>
              </button>
            </div>

            {studio.enabled && studio.mode === "garden" ? (
              <div className="mt-3">
                <LiveStudio mode="garden" />
              </div>
            ) : null}

            <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
              {gardenPlots.map((plot) => (
                <div
                  key={plot.id}
                  className="card"
                  style={{ background: "#f7fee7", borderColor: "#d9f99d" }}
                >
                  <strong>{plot.crop}</strong> – {plot.location}
                </div>
              ))}
              {gardenPlots.length === 0 && (
                <p className="subtitle">No plots yet—add one above.</p>
              )}
            </div>
          </section>
        );

      case "animals":
        return (
          <section className="card">
            <h2 style={{ marginTop: 0 }}>🐓 Animal Plans</h2>
            <p className="subtitle">
              Coordinate who raises which animals to share eggs, milk, and meat.
            </p>

            <AnimalFormEditor value={animalForm} onChange={setAnimalForm} />

            <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
              <button className="btn primary sm" onClick={handleAddAnimalPlan}>
                <span className="label">➕ Add My Animal Plan</span>
              </button>
              <button className="btn sm" onClick={syncCommunity}>
                <span className="label">Sync</span>
              </button>
            </div>

            <div style={{ display: "grid", gap: 8 }}>
              {animalPlans.map((plan) => (
                <div
                  key={plan.id}
                  className="card"
                  style={{ background: "#fffbeb", borderColor: "#fde68a" }}
                >
                  <strong>{plan.animal}</strong> – for {plan.purpose}
                </div>
              ))}
              {animalPlans.length === 0 && (
                <p className="subtitle">No animal plans yet—add one above.</p>
              )}
            </div>
          </section>
        );

      default:
        return null;
    }
  };

  /* ----------------------------- UI ----------------------------- */
  return (
    <div>
      <h1>🤝 Community Hub</h1>
      <p className="subtitle">
        Go live with “Cook With Me”, “Clean With Me”, and share Garden Co-Op progress. Studio
        Mode gives you overlays, teleprompter, and deep session topics—perfect for livestreams or recordings.
      </p>

      {/* Tabs as tactile buttons */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "6px 0 12px" }}>
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`btn sm ${activeTab === tab.key ? "primary" : ""}`}
          >
            <span className="label">{tab.label}</span>
          </button>
        ))}
        <button className="btn sm" aria-busy={busy} onClick={syncCommunity}>
          <span className="label">Sync All</span>
        </button>
        {ok ? <span className="subtitle" style={{ color: "var(--success)" }}>✓ Updated</span> : null}
      </div>

      {/* Content */}
      <div>{renderContent()}</div>

      {/* Friendly “Last Automation Output” */}
      <AutomationOutput lastOutput={lastOutput} />
    </div>
  );
}

/* ========================= editors ========================= */

function RoomPrefsEditor({ roomPrefs, setRoomPrefs }) {
  const [local, setLocal] = useState(roomPrefs);
  useEffect(() => setLocal(roomPrefs), [roomPrefs]);

  return (
    <div className="card" style={{ background: "#fff", borderColor: "#e5e7eb", marginBottom: 12 }}>
      <div className="subtitle"><strong>Room Preferences</strong></div>
      <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
        <label className="field">
          <div className="subtitle" style={{ marginBottom: 4 }}>Days</div>
          <input
            className="btn"
            value={local.availability.days.join(", ")}
            onChange={(e) => {
              const days = e.target.value.split(",").map((d) => d.trim()).filter(Boolean);
              const next = { ...local, availability: { ...local.availability, days } };
              setLocal(next); setRoomPrefs(next);
            }}
            placeholder="Mon, Wed, Sat"
          />
        </label>

        <label className="field">
          <div className="subtitle" style={{ marginBottom: 4 }}>Start</div>
          <input
            type="time"
            className="btn"
            value={local.availability.start}
            onChange={(e) => {
              const next = { ...local, availability: { ...local.availability, start: e.target.value } };
              setLocal(next); setRoomPrefs(next);
            }}
          />
        </label>

        <label className="field">
          <div className="subtitle" style={{ marginBottom: 4 }}>End</div>
          <input
            type="time"
            className="btn"
            value={local.availability.end}
            onChange={(e) => {
              const next = { ...local, availability: { ...local.availability, end: e.target.value } };
              setLocal(next); setRoomPrefs(next);
            }}
          />
        </label>

        <label className="field">
          <div className="subtitle" style={{ marginBottom: 4 }}>Max Participants</div>
          <input
            type="number"
            className="btn"
            value={local.maxParticipants}
            min={2}
            onChange={(e) => {
              const next = { ...local, maxParticipants: Number(e.target.value) };
              setLocal(next); setRoomPrefs(next);
            }}
          />
        </label>

        <label className="field">
          <div className="subtitle" style={{ marginBottom: 4 }}>Privacy</div>
          <select
            className="btn"
            value={local.privacy}
            onChange={(e) => {
              const next = { ...local, privacy: e.target.value };
              setLocal(next); setRoomPrefs(next);
            }}
          >
            <option value="public">public</option>
            <option value="friends">friends</option>
            <option value="invite">invite</option>
          </select>
        </label>
      </div>
    </div>
  );
}

function GardenFormEditor({ value, onChange }) {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);

  const update = (patch) => {
    const next = { ...local, ...patch };
    setLocal(next);
    onChange(next);
  };

  const updateArray = (txt) =>
    txt.split(",").map((s) => s.trim()).filter(Boolean);

  return (
    <div className="card" style={{ background: "#fff", borderColor: "#e5e7eb", marginBottom: 12 }}>
      <div className="subtitle"><strong>Garden Settings</strong></div>
      <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
        <label className="field">
          <div className="subtitle" style={{ marginBottom: 4 }}>Zone</div>
          <input className="btn" value={local.zone} onChange={(e) => update({ zone: e.target.value })} />
        </label>
        <label className="field">
          <div className="subtitle" style={{ marginBottom: 4 }}>Beds</div>
          <input type="number" className="btn" value={local.beds} min={0}
                 onChange={(e) => update({ beds: Number(e.target.value) })} />
        </label>
        <label className="field">
          <div className="subtitle" style={{ marginBottom: 4 }}>Sq Ft / Bed</div>
          <input type="number" className="btn" value={local.sqftPerBed} min={0}
                 onChange={(e) => update({ sqftPerBed: Number(e.target.value) })} />
        </label>
        <label className="field">
          <div className="subtitle" style={{ marginBottom: 4 }}>Preferred Crops</div>
          <input className="btn"
                 value={local.preferredCrops.join(", ")}
                 onChange={(e) => update({ preferredCrops: updateArray(e.target.value) })} />
        </label>
        <label className="field">
          <div className="subtitle" style={{ marginBottom: 4 }}>Share Policy</div>
          <select className="btn" value={local.sharePolicy}
                  onChange={(e) => update({ sharePolicy: e.target.value })}>
            <option value="swap">swap</option>
            <option value="donate">donate</option>
            <option value="keep">keep</option>
          </select>
        </label>
      </div>
    </div>
  );
}

function AnimalFormEditor({ value, onChange }) {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);

  const update = (patch) => {
    const next = { ...local, ...patch };
    setLocal(next);
    onChange(next);
  };

  const updateSpecies = (key, v) => {
    const next = { ...local, species: { ...local.species, [key]: Number(v) } };
    setLocal(next);
    onChange(next);
  };

  const togglePurpose = (p) => {
    const has = local.purposes.includes(p);
    const next = has ? local.purposes.filter((x) => x !== p) : [...local.purposes, p];
    update({ purposes: next });
  };

  return (
    <div className="card" style={{ background: "#fff", borderColor: "#e5e7eb", marginBottom: 12 }}>
      <div className="subtitle"><strong>Animal Settings</strong></div>
      <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
        <label className="field">
          <div className="subtitle" style={{ marginBottom: 4 }}>Land (acres)</div>
          <input type="number" className="btn" value={local.landAcres} min={0}
                 onChange={(e) => update({ landAcres: Number(e.target.value) })} />
        </label>
        <label className="field">
          <div className="subtitle" style={{ marginBottom: 4 }}>Feed Capacity (lbs / month)</div>
          <input type="number" className="btn" value={local.feedCapacityMonthlyLbs} min={0}
                 onChange={(e) => update({ feedCapacityMonthlyLbs: Number(e.target.value) })} />
        </label>

        {Object.entries(local.species).map(([key, val]) => (
          <label key={key} className="field">
            <div className="subtitle" style={{ marginBottom: 4 }}>{key}</div>
            <input type="number" className="btn" value={val} min={0}
                   onChange={(e) => updateSpecies(key, e.target.value)} />
          </label>
        ))}

        <div className="field">
          <div className="subtitle" style={{ marginBottom: 4 }}>Purposes</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {["eggs", "milk", "meat", "compost"].map((p) => (
              <button
                key={p}
                className={`btn xs ${local.purposes.includes(p) ? "primary" : ""}`}
                onClick={() => togglePurpose(p)}
              >
                {p}
              </button>
            ))}
          </div>
        </div>

        <label className="field">
          <div className="subtitle" style={{ marginBottom: 4 }}>Share Policy</div>
          <select className="btn" value={local.sharePolicy}
                  onChange={(e) => update({ sharePolicy: e.target.value })}>
            <option value="swap">swap</option>
            <option value="donate">donate</option>
            <option value="keep">keep</option>
          </select>
        </label>
      </div>
    </div>
  );
}

/* ==================== Friendly automation output ==================== */

function AutomationOutput({ lastOutput }) {
  const [showRaw, setShowRaw] = useState(false);
  if (!lastOutput) return null;

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <div style={{ fontWeight: 700 }}>Latest Automations</div>
        <button className="btn xs" onClick={() => setShowRaw((s) => !s)}>
          {showRaw ? "Hide Raw" : "Show Raw"}
        </button>
      </div>

      {/* Garden */}
      {lastOutput.garden ? (
        <>
          <Section title="🌿 Garden: Planting Calendar">
            <RenderEventsLike data={lastOutput.garden.cal} />
          </Section>
          <Section title="🧩 Garden: Companion Layout">
            <RenderBlocksLike data={lastOutput.garden.layout} />
          </Section>
          <Section title="🪲 Garden: Scout Alerts">
            <RenderAlertsLike data={lastOutput.garden.scout} />
          </Section>
          <Section title="🥫 Garden: Preservation Plan">
            <RenderTasksLike data={lastOutput.garden.preserve} />
          </Section>
        </>
      ) : null}

      {/* Animals */}
      {lastOutput.animals ? (
        <>
          <Section title="🐣 Breeding Cycle">
            <RenderEventsLike data={lastOutput.animals.breed} />
          </Section>
          <Section title="🍽️ Feed Rotation">
            <RenderTasksLike data={lastOutput.animals.feed} />
          </Section>
          <Section title="♻️ Manure → Compost">
            <RenderTasksLike data={lastOutput.animals.manure} />
          </Section>
          <Section title="🌱 Soil & Water Keeper">
            <RenderTipsLike data={lastOutput.animals.soil} />
          </Section>
        </>
      ) : null}

      {/* Room start / Sync summary */}
      {lastOutput.room ? (
        <Section title="🎥 Room">
          <KeyVal data={lastOutput.room} />
        </Section>
      ) : null}
      {lastOutput.sync ? (
        <Section title="🔄 Sync">
          <KeyVal data={lastOutput.sync} />
        </Section>
      ) : null}

      {/* Raw JSON (optional) */}
      {showRaw ? (
        <pre style={{ marginTop: 12, whiteSpace: "pre-wrap", background: "#0b1220", color: "#e5e7eb", padding: 12, borderRadius: 10 }}>
          {JSON.stringify(lastOutput, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}

/* ------ smart renderers for common template shapes (defensive) ------ */

function Section({ title, children }) {
  return (
    <div className="card" style={{ background: "#fff", marginTop: 8 }}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>{title}</div>
      {children}
    </div>
  );
}

function RenderEventsLike({ data }) {
  const list = Array.isArray(data)
    ? data
    : Array.isArray(data?.events)
    ? data.events
    : Array.isArray(data?.calendarEvents)
    ? data.calendarEvents
    : [];
  if (!list.length) return <div className="subtitle">No items.</div>;
  return (
    <ul className="divide-y">
      {list.slice(0, 20).map((e, idx) => (
        <li key={idx} className="py-2 flex items-center justify-between">
          <div>{e.title || e.name || e.type || "Event"}</div>
          <div className="subtitle">{fmtDate(e.date || e.dateISO || e.when)}</div>
        </li>
      ))}
    </ul>
  );
}

function RenderBlocksLike({ data }) {
  const blocks = Array.isArray(data)
    ? data
    : Array.isArray(data?.blocks)
    ? data.blocks
    : [];
  if (!blocks.length) return <div className="subtitle">No layout generated.</div>;
  return (
    <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
      {blocks.slice(0, 12).map((b, idx) => (
        <div key={idx} className="rounded-xl border p-2 bg-white/70">
          <div className="text-sm font-medium">{b.title || b.name || "Block"}</div>
          <div className="subtitle">
            {b.kind ? `Type: ${b.kind} • ` : ""}{fmtDate(b.date)}
          </div>
        </div>
      ))}
    </div>
  );
}

function RenderAlertsLike({ data }) {
  const alerts = Array.isArray(data)
    ? data
    : Array.isArray(data?.alerts)
    ? data.alerts
    : [];
  if (!alerts.length) return <div className="subtitle">No alerts.</div>;
  return (
    <ul className="divide-y">
      {alerts.slice(0, 20).map((a, idx) => (
        <li key={idx} className="py-2">
          <div className="flex items-center justify-between">
            <strong>{a.crop || "Plot"}</strong>
            <span className="badge" style={{ background: sevColor(a.severity), color: "white" }}>
              {String(a.severity || "info").toUpperCase()}
            </span>
          </div>
          <div className="subtitle">{a.message || a.note || "—"}</div>
        </li>
      ))}
    </ul>
  );
}

function RenderTasksLike({ data }) {
  const tasks = Array.isArray(data)
    ? data
    : Array.isArray(data?.tasks)
    ? data.tasks
    : [];
  if (!tasks.length) return <div className="subtitle">No tasks.</div>;
  return (
    <ul className="divide-y">
      {tasks.slice(0, 20).map((t, idx) => (
        <li key={idx} className="py-2 flex items-center justify-between">
          <div>{t.title || t.name || "Task"}</div>
          <div className="subtitle">
            {t.assignee ? `${t.assignee} • ` : ""}
            {fmtDate(t.due || t.date)}
          </div>
        </li>
      ))}
    </ul>
  );
}

function RenderTipsLike({ data }) {
  const tips =
    Array.isArray(data?.tips)
      ? data.tips
      : Array.isArray(data)
      ? data
      : [];
  if (!tips.length) return <div className="subtitle">No tips.</div>;
  return (
    <ul className="list-disc pl-5">
      {tips.slice(0, 10).map((t, i) => (
        <li key={i} className="py-1">
          {typeof t === "string" ? t : t.tip || t.text || JSON.stringify(t)}
        </li>
      ))}
    </ul>
  );
}

function KeyVal({ data }) {
  if (!data || typeof data !== "object") return <div className="subtitle">No details.</div>;
  const entries = Object.entries(data);
  return (
    <div style={{ display: "grid", gap: 6 }}>
      {entries.map(([k, v]) => (
        <div key={k} className="flex items-start gap-2">
          <div className="badge" style={{ background: "#eef2ff" }}>{k}</div>
          <div className="subtitle">{pretty(v)}</div>
        </div>
      ))}
    </div>
  );
}

function pretty(v) {
  if (v == null) return "—";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean")
    return String(v);
  if (Array.isArray(v)) return v.slice(0, 6).map(pretty).join(", ") + (v.length > 6 ? " …" : "");
  if (typeof v === "object") {
    if (v.url || v.link) return String(v.url || v.link);
    if (v.title) return v.title;
    return JSON.stringify(v);
  }
  return String(v);
}

function sevColor(sev) {
  const s = String(sev || "info").toLowerCase();
  if (s === "high" || s === "severe") return "#ef4444";
  if (s === "medium" || s === "warn" || s === "warning") return "#f59e0b";
  if (s === "low" || s === "ok") return "#10b981";
  return "#64748b";
}

/* ========================== fun overlay ========================== */
function EmojiRain() {
  const [keys] = useState(() => Array.from({ length: 12 }, (_, i) => i));
  return (
    <div aria-hidden style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none" }}>
      {keys.map((k) => {
        const left = Math.random() * 100;
        const delay = Math.random() * 1.2;
        const duration = 3 + Math.random() * 2;
        const size = 18 + Math.random() * 16;
        return (
          <span
            key={k}
            style={{
              position: "absolute",
              left: `${left}%`,
              top: -30,
              fontSize: size,
              animation: `fall ${duration}s ${delay}s linear infinite`,
            }}
          >
            {["✨", "🎉", "🍅", "🧼", "🥗"][k % 5]}
          </span>
        );
      })}
      <style>{`@keyframes fall { to { transform: translateY(120%); opacity: .2; }}`}</style>
    </div>
  );
}

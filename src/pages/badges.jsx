// src/pages/badges.jsx
import React, { useEffect, useMemo, useState } from "react";
import { Award, Sparkles, CookingPot, Users } from "lucide-react";
import { automation } from "@/services/automation/runtime";
import "../index.css";

/* ----------------------------- Icon registry ----------------------------- */
// Render icons from a serializable key
const ICONS = {
  sparkles: Sparkles,
  cooking: CookingPot,
  users: Users,
  award: Award,
};
function renderIcon(iconKey, props = {}) {
  const Cmp = ICONS[iconKey] || Sparkles;
  return <Cmp {...props} />;
}

/* ------------------------- Starter badge catalog ------------------------- */
const defaultBadges = [
  {
    id: "clean_1",
    name: "First Sweep!",
    description: "Completed your first cleaning session.",
    iconKey: "sparkles",
    earned: false,
  },
  {
    id: "cook_1",
    name: "Kitchen Apprentice",
    description: "Completed your first batch cooking session.",
    iconKey: "cooking",
    earned: false,
  },
  {
    id: "group_1",
    name: "Teamwork Makes the Dream Work",
    description: "Joined a community 'Clean With Me' or 'Cook With Me' event.",
    iconKey: "users",
    earned: false,
  },
  {
    id: "sparkle_streak",
    name: "3-Day Streak!",
    description: "Maintained chores for 3 consecutive days.",
    iconKey: "sparkles",
    earned: false,
  },
];

/* ------------------------------ Migration ------------------------------- */
// If older localStorage entries used { icon: <JSX /> }, convert to { iconKey }
function migrateBadge(b) {
  if (!b) return b;
  if (!b.iconKey && b.icon) {
    // best-effort mapping based on id or component displayName/type
    const id = String(b.id || "").toLowerCase();
    let iconKey = "sparkles";
    if (id.includes("cook")) iconKey = "cooking";
    else if (id.includes("group") || id.includes("team")) iconKey = "users";
    b = { ...b, iconKey };
    delete b.icon;
  }
  return b;
}

/* --------------------------------- Page --------------------------------- */
export default function BadgesPage() {
  const [badges, setBadges] = useState(() => {
    const stored = localStorage.getItem("badges");
    if (!stored) return defaultBadges;
    try {
      const parsed = JSON.parse(stored);
      // migrate any legacy shape
      return Array.isArray(parsed) ? parsed.map(migrateBadge) : defaultBadges;
    } catch {
      return defaultBadges;
    }
  });

  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState(false);
  const [lastOutput, setLastOutput] = useState(null);

  // Persist whenever badges change
  useEffect(() => {
    localStorage.setItem("badges", JSON.stringify(badges));
  }, [badges]);

  // Simulate a first-run unlock (same logic you had, but callable)
  const simulateAchievements = async () => {
    const stat = {
      cleaningSessions: 1,
      cookingSessions: 1,
      joinedCommunityEvents: 1,
      dailyChoreStreak: 3,
    };
    setBadges((prev) =>
      prev.map((b) => {
        if (b.earned) return b;
        if (
          (b.id === "clean_1" && stat.cleaningSessions >= 1) ||
          (b.id === "cook_1" && stat.cookingSessions >= 1) ||
          (b.id === "group_1" && stat.joinedCommunityEvents >= 1) ||
          (b.id === "sparkle_streak" && stat.dailyChoreStreak >= 3)
        ) {
          return { ...b, earned: true };
        }
        return b;
      })
    );
  };

  // Try to sync via template; if missing, emit an event so your agents can respond
  const syncBadges = async () => {
    setBusy(true);
    setOk(false);
    setLastOutput(null);
    try {
      const res = await automation.runTemplate("badges.sync", {
        invokedBy: "ui/badges",
        knownBadges: badges.map((b) => ({ id: b.id, earned: b.earned })),
      });
      const grants = Array.isArray(res?.grants) ? res.grants : [];
      const revokes = Array.isArray(res?.revokes) ? res.revokes : [];
      setBadges((prev) =>
        prev.map((b) =>
          grants.includes(b.id)
            ? { ...b, earned: true }
            : revokes.includes(b.id)
            ? { ...b, earned: false }
            : b
        )
      );
      setLastOutput({ via: "template", res });
      setOk(true);
      setTimeout(() => setOk(false), 900);
    } catch (e) {
      automation.emit("event", {
        type: "badges/sync_request",
        payload: { invokedBy: "ui/badges", knownBadges: badges },
      });
      setLastOutput({ via: "event", emitted: true, error: e?.message });
      setOk(true);
      setTimeout(() => setOk(false), 900);
    } finally {
      setBusy(false);
    }
  };

  const grantTestBadge = () => {
    const idx = badges.findIndex((b) => !b.earned);
    if (idx === -1) return;
    const copy = badges.slice();
    copy[idx] = { ...copy[idx], earned: true };
    setBadges(copy);
  };

  const resetAll = () => {
    setBadges(defaultBadges);
    setLastOutput(null);
  };

  const earnedCount = useMemo(
    () => badges.filter((b) => b.earned).length,
    [badges]
  );

  return (
    <div>
      <h1>🏅 My Badges</h1>
      <p className="subtitle">
        Collect achievements as you clean, cook, garden, and coordinate your home.
      </p>

      {/* Actions */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "8px 0 16px" }}>
        <button className="btn primary sm" aria-busy={busy} onClick={syncBadges}>
          <span className="label">Sync Badges</span>
        </button>
        <button className="btn sm" onClick={simulateAchievements}>
          <span className="label">Simulate Achievements</span>
        </button>
        <button className="btn sm" onClick={grantTestBadge}>
          <span className="label">Grant Test Badge</span>
        </button>
        <button className="btn sm" onClick={resetAll}>
          <span className="label">Reset All</span>
        </button>
        {ok ? <span className="subtitle" style={{ color: "var(--success)" }}>✓ Updated</span> : null}
      </div>

      {/* Summary */}
      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {renderIcon("award")}
          <strong>{earnedCount}</strong>&nbsp;/&nbsp;{badges.length} badges earned
        </div>
      </div>

      {/* Badge grid */}
      <div
        style={{
          display: "grid",
          gap: 12,
          gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
        }}
      >
        {badges.map((badge) => {
          const border = badge.earned ? "2px solid #f59e0b" : "1px solid var(--line)";
          const bg = badge.earned ? "#fff8e6" : "var(--surface)";
          const opacity = badge.earned ? 1 : 0.65;

          return (
            <div key={badge.id} className="card" style={{ border, background: bg, opacity }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                <div
                  style={{
                    width: 38,
                    height: 38,
                    borderRadius: "50%",
                    display: "grid",
                    placeItems: "center",
                    background: "white",
                    border: "1px solid var(--line)",
                    boxShadow: "var(--shadow)",
                  }}
                >
                  {renderIcon(badge.iconKey)}
                </div>
                <h2 style={{ margin: 0, fontSize: "1.1rem" }}>{badge.name}</h2>
              </div>
              <p className="subtitle" style={{ marginTop: 0 }}>{badge.description}</p>
              {badge.earned ? (
                <div style={{ color: "var(--success)", fontWeight: 700 }}>✅ Earned</div>
              ) : (
                <div className="subtitle">🔒 Locked</div>
              )}
            </div>
          );
        })}
      </div>

      {/* Output / logs */}
      {lastOutput && (
        <div className="card" style={{ marginTop: 16 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Last Sync Output</div>
          <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>
            {JSON.stringify(lastOutput, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

// C:\Users\larho\suka-smart-assistant\src\social\WeeklyChallengeManager.js
/**
 * WeeklyChallengeManager (dynamic, agent- & Sabbath-aware)
 * -------------------------------------------------------
 * Generates and tracks weekly challenges across household domains with
 * personalization, agent suggestions, overlays, and soft integrations
 * (socket, n8n). Uses Dexie if available; gracefully degrades.
 *
 * Features:
 * - Dynamic sources: default templates → overlays → agent suggestions
 * - One featured challenge per domain (cleaning, cooking, gardening, animals)
 * - Sabbath-aware selection (avoid-store/long-run tasks if configured)
 * - Weighted randomness with difficulty/points
 * - Progress API and completion events (window + socket + optional n8n)
 * - Regeneration and adoption from existing plans (e.g., vision/recipes)
 *
 * Dexie tables assumed (if present):
 *   weeklyChallenges: { id: weekId, weekId, startDateISO, challenges[], createdAtISO }
 *   userMeta (optional): for storing points/streak if you decide to extend
 */

import DexieDB from "../db";
import { v4 as uuidv4 } from "uuid";

// ---------- Safe dynamic imports ----------
async function safeImportMany(paths = []) {
  for (const p of paths) {
    try {
      // @vite-ignore
      const mod = await import(p);
      return mod?.default || mod;
    } catch {}
  }
  return null;
}

function safeGetSocket() {
  try {
    // eslint-disable-next-line import/no-unresolved
    return require("../server/services/socket")?.getSocket?.() || null;
  } catch {
    return null;
  }
}

let EVENTS = {};
(async () => {
  try {
    const ont = await safeImportMany([
      "@/shared/ontology.js",
      "@/shared/ontology",
    ]);
    EVENTS = ont?.EVENTS || {};
  } catch {}
})();

// ---------- Settings loader (quiet hours / sabbath) ----------
async function loadSettings() {
  const Settings = await safeImportMany([
    "@/store/SettingsStore.js",
    "@/store/SettingsStore",
  ]);
  const get = async (k, d) => {
    try {
      const v = await Settings?.get?.(k);
      return v ?? d;
    } catch {
      return d;
    }
  };
  return {
    sabbathAvoid: await get("sabbath.avoidSaturday", true),
    profileKey: await get("profile.key", "standard-home"),
  };
}

// ---------- Sabbath helper (approx, can be overridden by ontology.sabbath) ----------
async function isSabbathNow() {
  try {
    const ont = await safeImportMany([
      "@/shared/ontology.js",
      "@/shared/ontology",
    ]);
    const win = ont?.sabbath?.(new Date());
    if (win?.startISO && win?.endISO) {
      const now = new Date();
      return now >= new Date(win.startISO) && now < new Date(win.endISO);
    }
  } catch {}
  // fallback Fri 18:00 → Sat 18:00
  const now = new Date();
  const day = now.getDay();
  const fri18 = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + ((5 - day + 7) % 7),
    18,
    0,
    0,
    0
  );
  const sat18 = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + ((6 - day + 7) % 7),
    18,
    0,
    0,
    0
  );
  return now >= fri18 && now < sat18;
}

// ---------- Categories (can be overlayed via ontology or global) ----------
const BASE_CATEGORIES = ["cleaning", "cooking", "gardening", "animal care"];

// ---------- Default templates (weighted) ----------
const DEFAULT_CHALLENGES = {
  cleaning: [
    {
      title: "Deep clean a high-visibility zone",
      weight: 1.0,
      points: 40,
      tags: ["zone", "deep"],
      sabbathSafe: true,
    },
    {
      title: "Disinfect 3 high-touch surfaces daily for 5 days",
      weight: 0.8,
      points: 60,
      tags: ["habit", "sanitization"],
      sabbathSafe: true,
    },
    {
      title: "Organize and label one cleaning supply zone",
      weight: 0.9,
      points: 35,
      tags: ["organize", "label"],
      sabbathSafe: true,
    },
  ],
  cooking: [
    {
      title: "Batch cook 3 freezer meals from pantry",
      weight: 0.95,
      points: 60,
      tags: ["batch", "freezer", "inventory"],
      sabbathSafe: true,
    },
    {
      title: "Try a new recipe and record audio steps",
      weight: 0.7,
      points: 45,
      tags: ["learning", "record"],
      sabbathSafe: true,
    },
    {
      title: "Plan a full feast meal using in-house inventory only",
      weight: 0.8,
      points: 55,
      tags: ["planning", "inventory-only"],
      sabbathSafe: true,
    },
  ],
  gardening: [
    {
      title: "Plant or transplant 5 seedlings",
      weight: 0.9,
      points: 35,
      tags: ["planting"],
      sabbathSafe: true,
    },
    {
      title: "Weed a garden zone and log it",
      weight: 1.0,
      points: 30,
      tags: ["weeding", "logging"],
      sabbathSafe: true,
    },
    {
      title: "Harvest and preserve at least 1 crop",
      weight: 0.85,
      points: 55,
      tags: ["harvest", "preserve"],
      sabbathSafe: true,
    },
  ],
  "animal care": [
    {
      title: "Track and log feeding for a full week",
      weight: 1.0,
      points: 45,
      tags: ["tracking", "habit"],
      sabbathSafe: true,
    },
    {
      title: "Clean animal housing area and log the task",
      weight: 0.9,
      points: 40,
      tags: ["clean", "log"],
      sabbathSafe: true,
    },
    {
      title: "Check water and feed levels daily for all animals",
      weight: 0.85,
      points: 35,
      tags: ["habit", "care"],
      sabbathSafe: true,
    },
  ],
};

// ---------- Overlays (window.__SUKA_CHALLENGES__ or ./challenges.local.js) ----------
async function loadOverlays() {
  let overlay = {};
  if (typeof window !== "undefined" && window.__SUKA_CHALLENGES__) {
    overlay = { ...overlay, ...(window.__SUKA_CHALLENGES__ || {}) };
  }
  try {
    // eslint-disable-next-line global-require
    const local = require("./challenges.local.js");
    overlay = { ...overlay, ...(local?.default || local || {}) };
  } catch {}
  return overlay;
}

// ---------- Agent suggestions (best-effort) ----------
async function agentSuggestions(profileKey) {
  const [cleaning, cooking, gardening, animals] = await Promise.all([
    safeImportMany(["@/agents/cleaningShim.js", "@/agents/cleaningAgent"]),
    safeImportMany(["@/agents/cookingShim.js", "@/agents/cookingAgent"]),
    safeImportMany(["@/agents/gardeningShim.js", "@/agents/gardeningAgent"]),
    safeImportMany(["@/agents/animalShim.js", "@/agents/animalAgent"]),
  ]);

  const out = {};
  try {
    const res = await cleaning?.estimatePlan?.(
      {},
      { preset: "high-visibility-rooms" }
    );
    if (res?.suggestions?.length)
      out.cleaning = res.suggestions.map((s) => ({
        title: s.title || s.text || s,
        weight: 0.8,
        points: 35,
        sabbathSafe: true,
      }));
  } catch {}
  try {
    const res = await cooking?.estimatePlan?.(
      {},
      {
        preset:
          profileKey === "agrarian-offgrid" ? "pantry-forward" : "standard",
      }
    );
    if (res?.suggestions?.length)
      out.cooking = res.suggestions.map((s) => ({
        title: s.title || s.text || s,
        weight: 0.75,
        points: 45,
        sabbathSafe: true,
      }));
  } catch {}
  try {
    const res = await gardening?.estimatePlan?.({}, { window: "this-week" });
    if (res?.suggestions?.length)
      out.gardening = res.suggestions.map((s) => ({
        title: s.title || s.text || s,
        weight: 0.85,
        points: 40,
        sabbathSafe: true,
      }));
  } catch {}
  try {
    const res = await animals?.estimatePlan?.({}, { preset: "weekly" });
    if (res?.suggestions?.length)
      out["animal care"] = res.suggestions.map((s) => ({
        title: s.title || s.text || s,
        weight: 0.8,
        points: 40,
        sabbathSafe: true,
      }));
  } catch {}

  return out;
}

// ---------- Utils ----------
function nowISO() {
  return new Date().toISOString();
}
function startOfWeek(date = new Date()) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday start
  const s = new Date(d.setDate(diff));
  s.setHours(0, 0, 0, 0);
  return s;
}
function getWeekNumber(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
}
function getCurrentWeekId() {
  const today = new Date();
  const year = today.getFullYear();
  const week = getWeekNumber(today);
  return `week-${year}-${week}`;
}
function pickWeighted(arr = []) {
  if (!arr.length) return null;
  const sum = arr.reduce((a, x) => a + (Number(x.weight) || 1), 0);
  let roll = Math.random() * sum;
  for (const x of arr) {
    roll -= Number(x.weight) || 1;
    if (roll <= 0) return x;
  }
  return arr[arr.length - 1];
}
function normalizePool(pool) {
  return (pool || []).map((x, i) => ({
    id: x.id || `tpl_${i}`,
    title: String(x.title || "").trim() || `Challenge ${i + 1}`,
    weight: Number(x.weight ?? 1) || 1,
    points: Number(x.points ?? 35) || 35,
    sabbathSafe: x.sabbathSafe !== false, // default true
    tags: Array.isArray(x.tags) ? x.tags : [],
  }));
}

// ---------- n8n helper (optional) ----------
async function notifyN8n(event, payload) {
  const n8n = await safeImportMany([
    "@/services/n8nClient.js",
    "@/services/n8nClient",
  ]);
  try {
    await n8n?.runWorkflowByName?.(
      "Suka: Weekly Challenge Event",
      { event, payload },
      {
        idempotencyKey: `${event}:${payload?.weekId || ""}:${
          payload?.challengeId || ""
        }`,
      }
    );
  } catch {}
}

// ---------- Persistence wrappers ----------
async function getDoc(weekId) {
  try {
    return await DexieDB.weeklyChallenges.get(weekId);
  } catch {
    // fallback to memory/localStorage if needed
    try {
      const raw = localStorage.getItem(`weeklyChallenges:${weekId}`);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }
}
async function putDoc(doc) {
  doc.updatedAtISO = nowISO();
  try {
    await DexieDB.weeklyChallenges.put(doc);
  } catch {
    try {
      localStorage.setItem(
        `weeklyChallenges:${doc.weekId}`,
        JSON.stringify(doc)
      );
    } catch {}
  }
  return doc;
}

// ---------- Public API ----------
const WeeklyChallengeManager = {
  /**
   * Generate a weekly challenge set (one per category) unless already exists.
   * Sources: defaults → overlays → agent suggestions; Sabbath-safe filter applied if configured.
   */
  async generateNewChallengesForWeek(weekId = getCurrentWeekId()) {
    const existing = await getDoc(weekId);
    if (existing) return existing;

    const [overlay, sett, agentSug] = await Promise.all([
      loadOverlays(),
      loadSettings(),
      (async () => {
        const s = await loadSettings();
        return agentSuggestions(s.profileKey);
      })(),
    ]);

    const categories = overlay?.categories?.length
      ? overlay.categories
      : BASE_CATEGORIES;

    const sabbathNow = await isSabbathNow();
    const sabbathAvoid = sett.sabbathAvoid !== false;

    const pool = (cat) => {
      const def = DEFAULT_CHALLENGES[cat] || [];
      const over = normalizePool(overlay?.templates?.[cat] || []);
      const sug = normalizePool(agentSug?.[cat] || []);
      // Merge: agent > overlay > default (all available for pick)
      return normalizePool([...def, ...over, ...sug]);
    };

    const challenges = categories.map((category) => {
      let options = pool(category);
      // Sabbath-aware: if we are within Sabbath and avoidance is enabled, filter to sabbathSafe
      if (sabbathNow && sabbathAvoid) {
        options = options.filter((o) => o.sabbathSafe !== false);
      }
      // fallback if all filtered out
      if (!options.length) options = pool(category);

      const chosen = pickWeighted(options) || {
        title: "Complete a useful household task",
        points: 30,
        sabbathSafe: true,
      };
      return {
        id: uuidv4(),
        category,
        title: chosen.title,
        points: chosen.points,
        tags: chosen.tags,
        sabbathSafe: chosen.sabbathSafe !== false,
        completedBy: [],
        completions: [], // { userId, atISO }
      };
    });

    const start = startOfWeek();
    const challengeDoc = {
      id: weekId,
      weekId,
      startDateISO: start.toISOString(),
      challenges,
      createdAtISO: nowISO(),
      meta: {
        profileKey: sett.profileKey,
        sabbathAvoid: sett.sabbathAvoid !== false,
        source: "generated",
      },
    };

    await putDoc(challengeDoc);

    // notify UI + socket + n8n
    try {
      window.dispatchEvent?.(
        new CustomEvent("social:weeklyChallenges:generated", {
          detail: { weekId },
        })
      );
    } catch {}
    try {
      safeGetSocket()?.emit?.("social/weeklyChallenges/generated", {
        weekId,
        count: challenges.length,
      });
    } catch {}
    notifyN8n("generated", { weekId, count: challenges.length }).catch(
      () => {}
    );

    return challengeDoc;
  },

  /**
   * Return current week's challenges (generates if missing).
   */
  async getCurrentChallenges() {
    const weekId = getCurrentWeekId();
    let doc = await getDoc(weekId);
    if (!doc) {
      doc = await this.generateNewChallengesForWeek(weekId);
    }
    return doc;
  },

  /**
   * Mark a user as having completed a challenge.
   * Emits progress events and optional n8n workflow.
   */
  async markComplete({
    weekId = getCurrentWeekId(),
    challengeId,
    userId = "localUser",
  }) {
    const doc = await getDoc(weekId);
    if (!doc) return null;

    let changed = false;
    const updated = doc.challenges.map((ch) => {
      if (ch.id !== challengeId) return ch;
      if (ch.completedBy.includes(userId)) return ch;
      changed = true;
      return {
        ...ch,
        completedBy: [...ch.completedBy, userId],
        completions: [...(ch.completions || []), { userId, atISO: nowISO() }],
      };
    });

    if (!changed) return doc;

    const next = { ...doc, challenges: updated };
    await putDoc(next);

    // analytics/progress ping
    const completedCount = updated.filter((c) =>
      c.completedBy.includes(userId)
    ).length;
    const total = updated.length;
    const payload = { weekId, challengeId, userId, completedCount, total };

    try {
      window.dispatchEvent?.(
        new CustomEvent("social:weeklyChallenges:completed", {
          detail: payload,
        })
      );
    } catch {}
    try {
      const sock = safeGetSocket();
      sock?.emit?.("social/weeklyChallenges/completed", payload);
      // also hint orchestrator if present
      sock?.emit?.(
        EVENTS?.SESSION?.FINISHED?.CLEANING || "SESSION.FINISHED.CLEANING",
        { at: nowISO(), reason: "challenge-completed" }
      );
    } catch {}

    notifyN8n("completed", payload).catch(() => {});
    return next;
  },

  /**
   * Get simple progress for a user for a week.
   */
  async getProgressForUser(userId = "localUser", weekId = getCurrentWeekId()) {
    const doc = await getDoc(weekId);
    if (!doc) return { weekId, completed: 0, total: 0, points: 0 };

    const total = doc.challenges.length;
    let completed = 0;
    let points = 0;

    for (const ch of doc.challenges) {
      if (ch.completedBy?.includes(userId)) {
        completed += 1;
        points += Number(ch.points || 0);
      }
    }
    return { weekId, completed, total, points };
  },

  /**
   * Regenerate this week’s challenges (admin/dev helper).
   */
  async regenerateThisWeek() {
    const weekId = getCurrentWeekId();
    // Delete then generate
    try {
      await DexieDB.weeklyChallenges.delete(weekId);
    } catch {
      try {
        localStorage.removeItem(`weeklyChallenges:${weekId}`);
      } catch {}
    }
    return this.generateNewChallengesForWeek(weekId);
  },

  /**
   * Adopt tasks from existing plans (e.g., recipe consolidation or cleaning routine)
   * and turn them into challenges next week.
   */
  async adoptFromPlan({ category, titles = [], nextWeek = false } = {}) {
    if (!category || !titles?.length) return null;
    const now = new Date();
    const weekId = nextWeek
      ? `week-${now.getFullYear()}-${getWeekNumber(
          new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7)
        )}`
      : getCurrentWeekId();

    const doc =
      (await getDoc(weekId)) ||
      (await this.generateNewChallengesForWeek(weekId));
    const idx = doc.challenges.findIndex((c) => c.category === category);
    if (idx >= 0 && titles[0]) {
      doc.challenges[idx] = {
        ...doc.challenges[idx],
        title: titles[0],
        points: Math.max(35, Number(doc.challenges[idx].points || 0)),
        tags: Array.from(
          new Set([...(doc.challenges[idx].tags || []), "adopted"])
        ),
      };
      await putDoc(doc);

      try {
        window.dispatchEvent?.(
          new CustomEvent("social:weeklyChallenges:adopted", {
            detail: { weekId, category },
          })
        );
      } catch {}
      safeGetSocket()?.emit?.("social/weeklyChallenges/adopted", {
        weekId,
        category,
      });
      return doc;
    }
    return null;
  },

  // Expose helpers in case other modules need them
  utils: {
    getCurrentWeekId,
    startOfWeek,
  },
};

export default WeeklyChallengeManager;

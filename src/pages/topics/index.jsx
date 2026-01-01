// src/pages/topics/index.jsx
/* eslint-disable no-console */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";

/* --------------------------------- Utils --------------------------------- */
const isBrowser = typeof window !== "undefined";
const now = () => Date.now();
const toISO = (ts) => new Date(ts || Date.now()).toISOString();
const safeJSON = {
  parse: (s, f = null) => { try { return JSON.parse(s); } catch { return f; } },
  stringify: (o) => { try { return JSON.stringify(o); } catch { return "{}"; } },
};

/* --------------------------- Defensive dependencies ------------------------ */
let eventBus = { on(){}, off(){}, emit(){} };
try {
  const eb = require("@/services/eventBus");
  eventBus = (eb && (eb.default || eb.eventBus || eb)) || eventBus;
} catch (_e) {}

let DexieDB = null;
try { DexieDB = require("@/db").default || require("@/db"); } catch (_e) {}

let PlanStorageRouter = null; // cloud/drive/local bridge
try { PlanStorageRouter = require("@/services/plans/PlanStorageRouter").default; } catch (_e) {}

let useFavoritePlans = null; // Zustand hook (optional)
try { useFavoritePlans = require("@/hooks/useFavoritePlans").default; } catch (_e) {}

let SavePlanButton = null; // optional shared component
try { SavePlanButton = require("@/components/plans/SavePlanButton.jsx").default; } catch (_e) {}

let FavoritePicker = null; // optional picker UI
try { FavoritePicker = require("@/components/plans/FavoritePicker.jsx").default; } catch (_e) {}

/* ------------------------------- Fallback data ----------------------------- */
let TopicsRegistry = null;
try { TopicsRegistry = require("@/data/topics.registry").default; } catch (_e) {}

/** Curated evergreen topics across all four modules */
const BUILTIN_TOPICS = [
  /* ------------------------------ MEALS ----------------------------------- */
  { id: "banana-bread", title: "Banana Bread Recipe", domain: "meals", tags: ["baking","dessert","evergreen","whole-grain"], popularity: 98 },
  { id: "french-toast", title: "French Toast Recipe", domain: "meals", tags: ["breakfast","evergreen"], popularity: 92 },
  { id: "apple-crumble", title: "Apple Crumble", domain: "meals", tags: ["dessert","baking","seasonal"], popularity: 88 },
  { id: "smash-burgers", title: "Smash Burgers Night", domain: "meals", tags: ["dinner","grilling","crowd-pleaser"], popularity: 90 },
  { id: "desserts-index", title: "Desserts (Master Index)", domain: "meals", tags: ["evergreen","index"], popularity: 85 },
  { id: "lasagna-classic", title: "Classic Lasagna (Batchable)", domain: "meals", tags: ["dinner","batchable","freezer"], popularity: 95 },
  { id: "house-bitters", title: "Homemade Bitters", domain: "meals", tags: ["beverage","infusion","pantry"], popularity: 72 },
  { id: "bakery-basics", title: "Bakery Basics", domain: "meals", tags: ["baking","flour","grains","technique"], popularity: 80 },
  { id: "fresh-ground-flour", title: "Fresh-Ground Whole-Grain Flour Guide", domain: "meals", tags: ["baking","whole-grain","health"], popularity: 86 },
  { id: "meal-prep-starters", title: "Meal-Prep Starters (Protein + Bases)", domain: "meals", tags: ["prep","freezer","batchable"], popularity: 83 },
  { id: "pressure-canned-broth", title: "Pressure-Canned Bone Broth", domain: "meals", tags: ["canning","pantry","batchable"], popularity: 79 },

  /* ----------------------------- CLEANING --------------------------------- */
  { id: "daily-reset", title: "Daily Reset Routine", domain: "cleaning", tags: ["routine","evergreen","streak"], popularity: 91 },
  { id: "weekly-zones", title: "Weekly Zone Clean (5-Zone Cycle)", domain: "cleaning", tags: ["planner","zones","evergreen"], popularity: 89 },
  { id: "laundry-system", title: "Laundry System (Queues + Folds)", domain: "cleaning", tags: ["laundry","workflow"], popularity: 84 },
  { id: "homemade-cleaners", title: "Homemade Cleaners (Vinegar, Citrus, Soap)", domain: "cleaning", tags: ["DIY","non-toxic","pantry"], popularity: 82 },
  { id: "bathroom-deep-clean", title: "Bathroom Deep Clean (Runbook)", domain: "cleaning", tags: ["deep-clean","checklist"], popularity: 80 },
  { id: "floor-care", title: "Floor Care (Sweep/Vac/Mop Cadence)", domain: "cleaning", tags: ["routine","cadence"], popularity: 78 },
  { id: "windows-mirrors", title: "Windows & Mirrors (No-Streak)", domain: "cleaning", tags: ["technique","shine"], popularity: 75 },
  { id: "15min-declutter", title: "15-Minute Declutter Sprints", domain: "cleaning", tags: ["declutter","quick-win"], popularity: 87 },

  /* ------------------------------ GARDEN ----------------------------------- */
  { id: "seed-starting", title: "Seed Starting (Lights + Schedule)", domain: "garden", tags: ["propagation","calendar"], popularity: 90 },
  { id: "transplant-beds", title: "Transplant Beds (Prep + Spacing)", domain: "garden", tags: ["soil","layout","plan"], popularity: 88 },
  { id: "succession-planting", title: "Succession Planting Planner", domain: "garden", tags: ["calendar","yield"], popularity: 86 },
  { id: "composting", title: "Composting (Hot/Cold/Sheet)", domain: "garden", tags: ["soil","inputs","evergreen"], popularity: 84 },
  { id: "mulch-strategy", title: "Mulch Strategy (Weeds + Moisture)", domain: "garden", tags: ["weed-control","water"], popularity: 80 },
  { id: "irrigation-cycles", title: "Irrigation & Dynamic Watering Cycles", domain: "garden", tags: ["watering","automation"], popularity: 85 },
  { id: "pest-management", title: "Pest Management (ID → Action)", domain: "garden", tags: ["ipm","safety"], popularity: 79 },
  { id: "harvest-logging", title: "Harvest Logging → Inventory Sync", domain: "garden", tags: ["inventory","preserve"], popularity: 83 },
  { id: "soil-testing", title: "Soil Testing & Amendments Map", domain: "garden", tags: ["soil","health"], popularity: 77 },

  /* ------------------------------ ANIMALS ---------------------------------- */
  { id: "poultry-daily", title: "Poultry Daily Care", domain: "animals", tags: ["checklist","feeding","watering"], popularity: 88 },
  { id: "egg-handling", title: "Egg Handling & Rotation", domain: "animals", tags: ["food-safety","inventory"], popularity: 84 },
  { id: "goat-milking", title: "Goat Milking Routine (Sanitation)", domain: "animals", tags: ["milking","sanitation"], popularity: 82 },
  { id: "on-farm-butchery", title: "On-Farm Butchery (All Species)", domain: "animals", tags: ["butchery","workflow","PPE"], popularity: 86 },
  { id: "red-meat-dropoff", title: "Red Meat Drop-Off Scheduling (USDA/State)", domain: "animals", tags: ["compliance","calendar"], popularity: 78 },
  { id: "brooder-setup", title: "Brooder Setup → Grow-Out", domain: "animals", tags: ["poultry","brooder"], popularity: 80 },
  { id: "pasture-rotation", title: "Pasture Rotation Planner", domain: "animals", tags: ["grazing","health"], popularity: 83 },
  { id: "predator-proofing", title: "Predator-Proofing Check", domain: "animals", tags: ["security","night-lock"], popularity: 79 },
  { id: "feed-inventory", title: "Feeds & Supplements Inventory", domain: "animals", tags: ["inventory","alerts"], popularity: 81 },
];

/* ------------------------------- Persistence ------------------------------- */
const LS_TOPICS_KEY = "suka:topics:user:v1";

async function loadUserTopics() {
  try {
    if (DexieDB?.topics) return await DexieDB.topics.toArray();
  } catch (_e) {}
  if (!isBrowser) return [];
  return safeJSON.parse(localStorage.getItem(LS_TOPICS_KEY), []);
}

async function saveUserTopic(topic) {
  try {
    if (DexieDB?.topics) { await DexieDB.topics.put(topic); return; }
  } catch (_e) {}
  if (!isBrowser) return;
  const prev = safeJSON.parse(localStorage.getItem(LS_TOPICS_KEY), []);
  const idx = prev.findIndex(t => t.id === topic.id);
  if (idx >= 0) prev[idx] = topic; else prev.push(topic);
  localStorage.setItem(LS_TOPICS_KEY, safeJSON.stringify(prev));
}

async function deleteUserTopic(id) {
  try {
    if (DexieDB?.topics) { await DexieDB.topics.delete(id); return; }
  } catch (_e) {}
  if (!isBrowser) return;
  const prev = safeJSON.parse(localStorage.getItem(LS_TOPICS_KEY), []);
  localStorage.setItem(LS_TOPICS_KEY, safeJSON.stringify(prev.filter(t => t.id !== id)));
}

/* ------------------------------- Bridges/CTAs ------------------------------ */
async function favoritePlan(meta, target = "local") {
  try {
    if (PlanStorageRouter?.savePlanFavorite) {
      return await PlanStorageRouter.savePlanFavorite({
        planId: meta.planId || `topic-plan:${meta.topicId}`,
        domain: meta.domain,
        source: "TopicsHub",
        target,
        meta,
      });
    }
  } catch (_e) {}
  try {
    if (typeof useFavoritePlans === "function") {
      const st = useFavoritePlans.getState?.();
      st?.addFavorite?.({
        id: meta.planId || `topic-plan:${meta.topicId}`,
        domain: meta.domain,
        title: meta.title,
        meta,
      });
      return { ok: true, via: "useFavoritePlans" };
    }
  } catch (_e) {}
  const key = "suka:favorites:plans";
  const prev = safeJSON.parse(localStorage.getItem(key), []);
  prev.push({
    id: meta.planId || `topic-plan:${meta.topicId}`,
    domain: meta.domain,
    title: meta.title,
    meta,
  });
  localStorage.setItem(key, safeJSON.stringify(prev));
  return { ok: true, via: "localStorage" };
}

function emitCreatePlanFromTopic(topic) {
  eventBus.emit?.("plan.fromTopic.requested", {
    domain: topic.domain || "meals",
    topicId: topic.id,
    title: topic.title,
    createdISO: toISO(),
    params: {
      tags: topic.tags || [],
      popularity: topic.popularity || 0,
      // Baking topics prefer fresh-ground flour as requested in earlier chats
      preferences: topic.tags?.includes("baking")
        ? { flour: "fresh-ground-whole-grain" }
        : {},
    },
  });
}

/* --------------------------------- UI Bits --------------------------------- */
function Pill({ children, className = "" }) {
  return (
    <span className={`inline-block px-2 py-0.5 text-xs rounded-full border ${className}`}>
      {children}
    </span>
  );
}

function TopicCard({ topic, onCreatePlan, onFavorite, onDelete, canDelete }) {
  return (
    <div className="rounded-2xl border shadow-sm p-4 flex flex-col gap-3 hover:shadow-md transition">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm uppercase tracking-wide opacity-60">{topic.domain || "general"}</div>
          <h3 className="text-lg font-semibold">{topic.title}</h3>
        </div>
        {topic.popularity != null && (
          <Pill className="opacity-70">Popularity {topic.popularity}</Pill>
        )}
      </div>

      {!!(topic.tags && topic.tags.length) && (
        <div className="flex flex-wrap gap-1.5">
          {topic.tags.map((t) => (
            <Pill key={t} className="opacity-70">{t}</Pill>
          ))}
        </div>
      )}

      <div className="mt-auto flex items-center gap-2 flex-wrap">
        <button className="px-3 py-1.5 rounded-xl border hover:bg-black/5" onClick={() => onCreatePlan?.(topic)}>
          Create Plan from Topic
        </button>

        <button
          className="px-3 py-1.5 rounded-xl border hover:bg-black/5"
          onClick={() => onFavorite?.(topic)}
          title="Save this as a Favorite Plan"
        >
          Save as Favorite
        </button>

        <Link to={`/topics/${topic.id}`} className="px-3 py-1.5 rounded-xl border hover:bg-black/5">
          Open Topic
        </Link>

        {canDelete && (
          <button
            className="ml-auto px-3 py-1.5 rounded-xl border text-red-700 hover:bg-red-50"
            onClick={() => onDelete?.(topic.id)}
            title="Remove custom topic"
          >
            Delete
          </button>
        )}
      </div>
    </div>
  );
}

function NewTopicModal({ open, onClose, onSave }) {
  const [title, setTitle] = useState("");
  const [domain, setDomain] = useState("meals");
  const [tags, setTags] = useState("");
  const [popularity, setPopularity] = useState(50);

  useEffect(() => {
    if (!open) { setTitle(""); setDomain("meals"); setTags(""); setPopularity(50); }
  }, [open]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 bg-black/40 z-40 flex items-center justify-center">
      <div className="bg-white w-full max-w-lg rounded-2xl p-5 shadow-xl">
        <h3 className="text-xl font-semibold mb-3">Add a Topic</h3>

        <label className="block text-sm mb-1">Title</label>
        <input
          className="w-full border rounded-xl px-3 py-2 mb-3"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g., Pasture Rotation, Weekly Zone Clean"
        />

        <label className="block text-sm mb-1">Domain</label>
        <select
          className="w-full border rounded-xl px-3 py-2 mb-3"
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
        >
          <option value="meals">Meals</option>
          <option value="cleaning">Cleaning</option>
          <option value="garden">Garden</option>
          <option value="animals">Animals</option>
        </select>

        <label className="block text-sm mb-1">Tags (comma-separated)</label>
        <input
          className="w-full border rounded-xl px-3 py-2 mb-3"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="baking, batchable, routine"
        />

        <label className="block text-sm mb-1">Popularity</label>
        <input
          className="w-full border rounded-xl px-3 py-2 mb-4"
          type="number" min={0} max={100}
          value={popularity}
          onChange={(e) => setPopularity(Number(e.target.value))}
        />

        <div className="flex items-center justify-end gap-2">
          <button className="px-3 py-1.5 rounded-xl border" onClick={onClose}>Cancel</button>
          <button
            className="px-3 py-1.5 rounded-xl border bg-black text-white"
            onClick={() => {
              const t = {
                id: title.toLowerCase().replace(/\s+/g, "-") + "-" + now(),
                title, domain, tags: tags.split(",").map(s => s.trim()).filter(Boolean),
                popularity: Number(popularity) || 0, userCreated: true, createdISO: toISO(),
              };
              onSave?.(t);
            }}
            disabled={!title.trim()}
          >
            Save Topic
          </button>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------- Page ------------------------------------ */
export default function TopicsIndexPage() {
  const [query, setQuery] = useState("");
  const [activeTags, setActiveTags] = useState([]);
  const [domain, setDomain] = useState("all");
  const [sortKey, setSortKey] = useState("popularity");
  const [groupByDomain, setGroupByDomain] = useState(true);
  const [userTopics, setUserTopics] = useState([]);
  const [openNew, setOpenNew] = useState(false);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const u = await loadUserTopics();
      if (mounted) setUserTopics(u || []);
    })();
    return () => { mounted = false; };
  }, []);

  const baseTopics = useMemo(() => {
    if (Array.isArray(TopicsRegistry) && TopicsRegistry.length) return TopicsRegistry;
    return BUILTIN_TOPICS;
  }, []);

  const allTopics = useMemo(() => {
    const map = new Map();
    for (const t of baseTopics) map.set(t.id, t);
    for (const u of userTopics) map.set(u.id, u);
    return Array.from(map.values());
  }, [baseTopics, userTopics]);

  const tagsUniverse = useMemo(() => {
    const s = new Set();
    allTopics.forEach(t => (t.tags || []).forEach(tag => s.add(tag)));
    return Array.from(s).sort();
  }, [allTopics]);

  const filtered = useMemo(() => {
    let list = allTopics;

    if (domain !== "all") list = list.filter(t => (t.domain || "other") === domain);

    if (activeTags.length) {
      list = list.filter(t => (t.tags || []).some(x => activeTags.includes(x)));
    }

    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter(t =>
        t.title.toLowerCase().includes(q) ||
        (t.tags || []).some(tag => tag.toLowerCase().includes(q)) ||
        (t.domain || "").toLowerCase().includes(q)
      );
    }

    if (sortKey === "alpha") list = [...list].sort((a, b) => a.title.localeCompare(b.title));
    else if (sortKey === "recent") list = [...list].sort((a, b) => (new Date(b.createdISO || 0) - new Date(a.createdISO || 0)));
    else list = [...list].sort((a, b) => (b.popularity || 0) - (a.popularity || 0));

    return list;
  }, [allTopics, domain, activeTags, query, sortKey]);

  /* ------------------------------- Handlers --------------------------------- */
  async function handleSaveTopic(topic) {
    await saveUserTopic(topic);
    const u = await loadUserTopics();
    setUserTopics(u || []);
    eventBus.emit?.("toast", { kind: "success", message: "Topic saved", tsISO: toISO() });
  }

  async function handleDeleteTopic(id) {
    await deleteUserTopic(id);
    const u = await loadUserTopics();
    setUserTopics(u || []);
    eventBus.emit?.("toast", { kind: "success", message: "Topic deleted", tsISO: toISO() });
  }

  async function handleFavorite(topic, target = "local") {
    const meta = {
      topicId: topic.id,
      title: `Plan: ${topic.title}`,
      domain: topic.domain || "meals",
      source: "TopicsHub",
      createdISO: toISO(),
      tags: topic.tags || [],
      hint: "Saved from Topics Hub",
    };
    const res = await favoritePlan(meta, target);
    if (res?.ok) eventBus.emit?.("toast", { kind: "success", message: "Saved as Favorite Plan", tsISO: toISO() });
    else eventBus.emit?.("toast", { kind: "error", message: "Could not save favorite", tsISO: toISO() });
  }

  function handleCreatePlan(topic) {
    emitCreatePlanFromTopic(topic);
    eventBus.emit?.("toast", { kind: "info", message: "Creating plan from topic…", tsISO: toISO() });
  }

  function toggleTag(tag) {
    setActiveTags((prev) => prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]);
  }

  /* --------------------------------- Render --------------------------------- */
  return (
    <div className="p-4 md:p-6 lg:p-8">
      <div className="mb-6 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="text-sm uppercase tracking-wide opacity-60">Explore</div>
          <h1 className="text-2xl md:text-3xl font-bold">Topics Hub</h1>
          <p className="opacity-70">Curate evergreen topics across Meals, Cleaning, Garden, and Animals. Spin up plans and save your best as favorites (local, Drive, or cloud).</p>
        </div>

        <div className="flex items-center gap-2">
          <button className="px-3 py-1.5 rounded-xl border" onClick={() => setOpenNew(true)}>+ Add Topic</button>
          {FavoritePicker ? <FavoritePicker /> : null}
        </div>
      </div>

      <div className="mb-4 grid grid-cols-1 md:grid-cols-5 gap-3">
        <input
          className="w-full border rounded-xl px-3 py-2"
          placeholder="Search topics, tags, domains…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        <select
          className="w-full border rounded-xl px-3 py-2"
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
        >
          <option value="all">All modules</option>
          <option value="meals">Meals</option>
          <option value="cleaning">Cleaning</option>
          <option value="garden">Garden</option>
          <option value="animals">Animals</option>
        </select>

        <select
          className="w-full border rounded-xl px-3 py-2"
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value)}
        >
          <option value="popularity">Sort: Popular</option>
          <option value="alpha">Sort: A → Z</option>
          <option value="recent">Sort: Recent</option>
        </select>

        <button
          className="w-full border rounded-xl px-3 py-2"
          onClick={() => setGroupByDomain(v => !v)}
          title="Toggle section grouping by module"
        >
          {groupByDomain ? "Grouped by Module" : "Ungrouped Grid"}
        </button>

        <button
          className="w-full border rounded-xl px-3 py-2"
          onClick={() => {
            const payload = { kind: "topics.export", createdISO: toISO(), topics: allTopics };
            eventBus.emit?.("topics.export.requested", payload);
            eventBus.emit?.("toast", { kind: "info", message: "Topics export emitted", tsISO: toISO() });
          }}
        >
          Export Topics (emit)
        </button>
      </div>

      {!!tagsUniverse.length && (
        <div className="mb-5 flex flex-wrap gap-1.5">
          {tagsUniverse.map((tag) => (
            <button
              key={tag}
              onClick={() => toggleTag(tag)}
              className={`px-3 py-1 rounded-full border ${activeTags.includes(tag) ? "bg-black text-white" : "hover:bg-black/5"}`}
            >
              #{tag}
            </button>
          ))}
          {!!activeTags.length && (
            <button className="ml-2 px-3 py-1 rounded-full border hover:bg-black/5" onClick={() => setActiveTags([])}>
              Clear tags
            </button>
          )}
        </div>
      )}

      {/* Grid / Grouped Sections */}
      {filtered.length === 0 ? (
        <div className="border rounded-2xl p-8 text-center opacity-70">
          No topics match your filters. Try clearing filters or adding a new topic.
        </div>
      ) : groupByDomain ? (
        <DomainSections
          items={filtered}
          onCreatePlan={handleCreatePlan}
          onFavorite={handleFavorite}
          onDelete={handleDeleteTopic}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {filtered.map((t) => (
            <TopicCard
              key={t.id}
              topic={t}
              canDelete={!!t.userCreated}
              onDelete={handleDeleteTopic}
              onCreatePlan={handleCreatePlan}
              onFavorite={(topic) => {
                if (SavePlanButton) {
                  eventBus.emit?.("plan.save.modal.open", {
                    source: "TopicsHub",
                    suggested: {
                      planId: `topic-plan:${topic.id}`,
                      title: `Plan: ${topic.title}`,
                      domain: topic.domain || "meals",
                      tags: topic.tags || [],
                    },
                  });
                } else {
                  handleFavorite(topic, "local");
                }
              }}
            />
          ))}
        </div>
      )}

      <NewTopicModal
        open={openNew}
        onClose={() => setOpenNew(false)}
        onSave={async (topic) => {
          await handleSaveTopic(topic);
          setOpenNew(false);
        }}
      />

      <CallbackWires />
    </div>
  );
}

/* ---------------------------- Grouped Sections ----------------------------- */
function DomainSections({ items, onCreatePlan, onFavorite, onDelete }) {
  const groups = useMemo(() => {
    const g = { meals: [], cleaning: [], garden: [], animals: [] };
    items.forEach(t => (g[t.domain] ? g[t.domain].push(t) : (g[t.domain] = [t])));
    return g;
  }, [items]);

  const order = ["meals","cleaning","garden","animals"];
  return (
    <div className="space-y-8">
      {order.map((d) => {
        const list = groups[d] || [];
        if (!list.length) return null;
        return (
          <section key={d}>
            <div className="flex items-baseline justify-between mb-3">
              <h2 className="text-xl font-semibold capitalize">{d}</h2>
              <Link to={`/topics?domain=${d}`} className="text-sm underline opacity-70">See more</Link>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {list.map((t) => (
                <TopicCard
                  key={t.id}
                  topic={t}
                  canDelete={!!t.userCreated}
                  onDelete={onDelete}
                  onCreatePlan={onCreatePlan}
                  onFavorite={(topic) => onFavorite(topic, "local")}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/* ----------------------------- Callback wiring ----------------------------- */
function CallbackWires() {
  const bound = useRef(false);

  useEffect(() => {
    if (bound.current) return;
    bound.current = true;

    function onConfirmSave(e) {
      const p = e?.payload || {};
      if (!p.planId || !p.title) return;

      favoritePlan({
        planId: p.planId,
        topicId: p.meta?.topicId || p.planId.replace(/^topic-plan:/, ""),
        title: p.title,
        domain: p.domain || "meals",
        tags: p.tags || [],
        source: "TopicsHub.SaveModal",
        createdISO: toISO(),
      }, p.target || "local").then((res) => {
        if (res?.ok) eventBus.emit?.("toast", { kind: "success", message: "Plan saved", tsISO: toISO() });
        else eventBus.emit?.("toast", { kind: "error", message: "Save failed", tsISO: toISO() });
      });
    }

    function add(ev, fn) { try { eventBus.on?.(ev, fn); } catch (_e) {} }
    function remove(ev, fn) { try { eventBus.off?.(ev, fn); } catch (_e) {} }

    add("plan.save.confirmed", onConfirmSave);
    return () => remove("plan.save.confirmed", onConfirmSave);
  }, []);

  return null;
}

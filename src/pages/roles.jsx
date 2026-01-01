// src/pages/roles.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import TaskLogManager from "@/managers/TaskLogManager";
import { automation } from "@/services/automation/runtime";

/* ----------------------------- Safe dynamic imports ----------------------------- */
async function tryImport(path) {
  try { const mod = await import(/* @vite-ignore */ path); return mod?.default || mod; }
  catch { return null; }
}

/* ---------------------------------- Areas ---------------------------------- */
const AREA_OPTIONS = [
  { id: "cooking",  label: "Cooking & Meals",      icon: "🍳" },
  { id: "cleaning", label: "Household Cleaning",   icon: "🧽" },
  { id: "inventory",label: "Inventory/Storehouse", icon: "📦" },
  { id: "garden",   label: "Garden",               icon: "🌱" },
  { id: "animal",   label: "Animal Care",          icon: "🐑" },
  { id: "errand",   label: "Errands/Shopping",     icon: "🛒" }
];

/* --------------------------------- UI bits -------------------------------- */
const Badge = ({ children }) => <span className="badge">{children}</span>;
const Card = ({ title, subtitle, right, children, className = "" }) => (
  <div className={`card ${className}`}>
    {(title || subtitle || right) && (
      <div className="flex items-start justify-between border-b pb-2 mb-3">
        <div>{title ? <h2 className="font-semibold m-0">{title}</h2> : null}{subtitle ? <p className="subtitle m-0">{subtitle}</p> : null}</div>
        {right ? <div className="shrink-0">{right}</div> : null}
      </div>
    )}
    {children}
  </div>
);
const EmptyState = ({ icon = "🗒️", title = "No tasks yet", hint }) => (
  <div className="flex flex-col items-center justify-center text-center gap-2 py-10 text-gray-500">
    <div className="text-3xl">{icon}</div><div className="font-medium">{title}</div>{hint ? <div className="text-sm">{hint}</div> : null}
  </div>
);

/* ------------------------------ Normalization ------------------------------ */
function normalizeTask(t) {
  return {
    id: String(t.id ?? `${t.source || "misc"}:${t.title ?? "task"}:${t.dueAt ?? Date.now()}`),
    title: t.title || "Task",
    area: t.area || t.type || "misc",
    priority: t.priority ?? 2,
    dueAt: t.dueAt ? new Date(t.dueAt).toISOString() : null,
    estMins: t.estMins ?? null,
    source: t.source || "unknown",
    assignedTo: t.assignedTo || null,
    icon: t.icon || "🧠",
    status: t.status || "pending",
    // cleaning hints (if present)
    room: t.room || t.details?.room || null,
    roomId: t.roomId || t.details?.roomId || null,
    roomType: t.roomType || t.details?.roomType || null
  };
}

/* --------------------------- Household data helpers --------------------------- */
async function collectHouseholdEnabledAreas() {
  const HomeStore = await tryImport("@/store/HomeStore");
  const Settings = await tryImport("@/store/SettingsStore");
  const enabled = new Set(Settings?.getHouseAreas?.() || []);
  (HomeStore?.getHouseAreas?.() || []).forEach((a) => enabled.add(a));
  if (enabled.size === 0) AREA_OPTIONS.forEach((a) => enabled.add(a.id));
  return Array.from(enabled);
}

async function getHouseholdPool() {
  const HouseholdStore = await tryImport("@/store/HouseholdStore");
  const JobsStore = await tryImport("@/store/JobsStore");

  const members = HouseholdStore?.getMembers?.() || []; // [{id,name,age,rooms:[{id,type}]}]
  const hires = JobsStore?.getActiveHires?.() || [];

  const toPerson = (p) => ({
    id: p.id || p.email || p.name,
    name: p.name || p.displayName || p.email || "Member",
    age: typeof p.age === "number" ? p.age : null,
    rooms: Array.isArray(p.rooms) ? p.rooms : []
  });

  const merged = [...members.map(toPerson), ...hires.map(toPerson)];
  return merged.length ? merged : [{ id: "household", name: "Household Pool", age: null, rooms: [] }];
}

/* ---------------------------- Fetch from sources --------------------------- */
async function gatherTasks(activeAreas) {
  const out = [];

  // 1) Core tasks/logs
  const base = await TaskLogManager.getHouseholdTasks({ types: activeAreas });
  base.forEach((t) => out.push(normalizeTask({ ...t, source: "TaskLog" })));

  // 2) Meal plan prep
  const MealPlanStore = await tryImport("@/store/MealPlanStore");
  if (MealPlanStore?.getPrepTasksForWeek) {
    (MealPlanStore.getPrepTasksForWeek() || []).forEach((t) =>
      out.push(normalizeTask({ ...t, area: "cooking", source: "MealPlan" }))
    );
  } else {
    const last = automation?.getLastOutput?.("meal-plan-weekly");
    (last?.outputs?.checklists?.daily || []).flat().forEach((t) =>
      out.push(normalizeTask({ ...t, area: "cooking", source: "MealPlan(auto)" }))
    );
  }

  // 3) Storehouse / Inventory
  const InventoryMonitor = await tryImport("@/managers/InventoryMonitor");
  if (InventoryMonitor?.getRestockTasks) {
    (await InventoryMonitor.getRestockTasks()).forEach((t) =>
      out.push(normalizeTask({ ...t, area: "inventory", source: "Inventory" }))
    );
  }

  // 4) Garden
  const GardenStore = await tryImport("@/store/GardenStore");
  if (GardenStore?.getUpcomingTasks) {
    (await GardenStore.getUpcomingTasks()).forEach((t) =>
      out.push(normalizeTask({ ...t, area: "garden", source: "Garden" }))
    );
  } else {
    const lastGarden = automation?.getLastOutput?.("garden-calendar");
    (lastGarden?.outputs?.blocks || []).forEach((b) =>
      out.push(normalizeTask({
        id: b.id || `${b.kind}:${b.date}:${b.title}`,
        title: b.title || `${b.kind} task`,
        area: "garden",
        dueAt: b.date,
        estMins: b.details?.mins || null,
        icon: "🌱",
        source: "Garden(auto)"
      }))
    );
  }

  // 5) Animals
  const AnimalQueueManager = await tryImport("@/managers/AnimalQueueManager");
  if (AnimalQueueManager?.getUpcomingTasks) {
    (await AnimalQueueManager.getUpcomingTasks()).forEach((t) =>
      out.push(normalizeTask({ ...t, area: "animal", source: "AnimalCare" }))
    );
  }

  // 6) Cleaning rotation (if automation populated)
  const lastCleaning = automation?.getLastOutput?.("cleaning-rotation");
  (lastCleaning?.outputs?.rotation?.assignments || []).forEach((b) =>
    out.push(
      normalizeTask({
        id: b.id || `clean:${b.date}:${b.room?.id || b.room}`,
        title: `Clean • ${b.room?.name || b.room} (${b.kind})`,
        area: "cleaning",
        dueAt: b.date,
        estMins: b.effortMins,
        icon: "🧽",
        source: "Cleaning(auto)",
        room: b.room?.name || b.room,
        roomId: b.room?.id || null,
        roomType: b.room?.type || null
      })
    )
  );

  // filter + sort
  const as = new Set(activeAreas);
  const filtered = out.filter((t) => as.has(t.area));
  filtered.sort((a, b) => {
    const ad = a.dueAt ? new Date(a.dueAt).getTime() : Infinity;
    const bd = b.dueAt ? new Date(b.dueAt).getTime() : Infinity;
    if (ad !== bd) return ad - bd;
    return (a.priority ?? 99) - (b.priority ?? 99);
  });

  return filtered;
}

/* ------------------------ Age eligibility & assignment ------------------------ */
// Simple age ladder. Tweak as needed.
const AGE_RULES = [
  { min: 4,  allow: ["tidy", "dust_low", "collect_trash"] },
  { min: 7,  allow: ["wipe_surfaces", "sweep", "feed_pets"] },
  { min: 10, allow: ["vacuum", "bathroom_quick_wipe", "dish_rinse"] },
  { min: 13, allow: ["mop", "bathroom_full", "appliance_wipe"] },
  { min: 16, allow: ["stove_oven_clean", "chemical_use_ok"] }
];
// Coarse task → capability tags
function capabilityTags(task) {
  const t = `${task.title} ${task.roomType || ""}`.toLowerCase();
  const tags = new Set();
  if (t.includes("vacuum")) tags.add("vacuum");
  if (t.includes("mop")) tags.add("mop");
  if (t.includes("wipe") || t.includes("counter") || t.includes("surface")) tags.add("wipe_surfaces");
  if (t.includes("bathroom") || t.includes("toilet") || (task.roomType === "bathroom")) {
    tags.add(t.includes("quick") ? "bathroom_quick_wipe" : "bathroom_full");
  }
  if (t.includes("stove") || t.includes("oven")) tags.add("stove_oven_clean");
  if (t.includes("trash")) tags.add("collect_trash");
  if (t.includes("dust")) tags.add("dust_low");
  if (t.includes("sweep")) tags.add("sweep");
  return tags.size ? Array.from(tags) : ["tidy"];
}
function isEligible(age, task) {
  if (!age) return true; // hires without age → assume allowed
  const tags = capabilityTags(task);
  const allowed = AGE_RULES.filter(r => age >= r.min).flatMap(r => r.allow);
  return tags.every(tag => allowed.includes(tag));
}

/* Personal vs Common area detection */
function isPersonalCleaning(task) {
  if (task.area !== "cleaning") return false;
  const rt = (task.roomType || "").toLowerCase();
  const rn = (task.room || "").toLowerCase();
  return rt === "bedroom" || rt === "bathroom" || rn.includes("bedroom") || rn.includes("bath");
}
function isCommonArea(task) {
  if (task.area !== "cleaning") return false;
  return !isPersonalCleaning(task);
}

/* Assign bedroom/bathroom to occupants; common areas round-robin by age eligibility */
function assignCleaning(tasks, people) {
  if (!people.length) return tasks;

  // Build room → occupants map from people.rooms
  const roomOwners = new Map(); // roomId or roomName → [person]
  people.forEach(p => (p.rooms || []).forEach(r => {
    const key = (r.id || r.name || r.label || "").toLowerCase();
    if (!key) return;
    if (!roomOwners.has(key)) roomOwners.set(key, []);
    roomOwners.get(key).push(p);
  }));

  const cloned = tasks.map(t => ({ ...t }));

  // 1) Personal rooms → assign to occupant(s)
  cloned.forEach(t => {
    if (!isPersonalCleaning(t)) return;
    const key = (t.roomId ? String(t.roomId) : (t.room || "")).toLowerCase();
    const owners = roomOwners.get(key) || []; // could be 1+ (shared bath/room)
    if (owners.length) {
      // If shared, prefer oldest eligible
      const elig = owners.filter(o => isEligible(o.age, t));
      const chosen = (elig.length ? elig : owners).sort((a,b)=> (b.age||0)-(a.age||0))[0];
      t.assignedTo = chosen?.name || t.assignedTo;
    }
  });

  // 2) Common areas → round-robin across eligible people
  const commons = cloned.filter(isCommonArea);
  const others  = cloned.filter(t => !isCommonArea(t));

  const eligible = people.filter(p => isEligible(p.age ?? null, { title:"", roomType:"" })) || people;
  let idx = 0;
  const commonsAssigned = commons.map(task => {
    const pool = people.filter(p => isEligible(p.age, task));
    const pickFrom = pool.length ? pool : eligible;
    const chosen = pickFrom[idx % pickFrom.length];
    idx++;
    return { ...task, assignedTo: task.assignedTo || chosen?.name || null };
  });

  return [...others, ...commonsAssigned];
}

/* ------------------------------ Main component ---------------------------- */
export default function RolesTasksPage() {
  const [enabledAreas, setEnabledAreas] = useState(AREA_OPTIONS.map(a => a.id));
  const [pool, setPool] = useState([]); // members + hires with age + rooms
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showOnlyMine, setShowOnlyMine] = useState(false);
  const meRef = useRef(null); // hook to your auth if desired

  // Initialize Household areas & pool
  useEffect(() => {
    let cancel = false;
    (async () => {
      const areas = await collectHouseholdEnabledAreas();
      const ppl   = await getHouseholdPool();
      if (!cancel) { setEnabledAreas(areas); setPool(ppl); }
    })();
    return () => { cancel = true; };
  }, []);

  // Gather and assign
  const refresh = async () => {
    setLoading(true);
    const list = await gatherTasks(enabledAreas);
    // apply bedroom/bathroom ownership + common-area distribution
    const withCleaningRules = assignCleaning(list, pool);
    setTasks(withCleaningRules);
    setLoading(false);
  };

  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [enabledAreas.join("|"), JSON.stringify(pool)]);

  // Live refresh when automations/stores emit signals
  useEffect(() => {
    if (typeof automation?.on !== "function") return;
    const off = [];
    const on = (evt, fn) => off.push(automation.on(evt, fn));
    const debounced = (() => { let t; return () => { clearTimeout(t); t = setTimeout(refresh, 400); }; })();

    on("inventory/changed", debounced);
    on("inventory/harvest", debounced);
    on("mealplan/updated", debounced);
    on("garden/bed_updated", debounced);
    on("garden/crop_planned", debounced);
    on("animals/queue_updated", debounced);
    on("cleaning/rotation_updated", debounced);

    return () => off.forEach((f) => { try { f?.(); } catch {} });
  }, []);

  const toggleArea = (id) => setEnabledAreas((prev) => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));

  const handleClaim = async (taskId, assigneeName) => {
    await TaskLogManager.assignTask?.(taskId, assigneeName);
    setTasks(prev => prev.map(x => x.id === taskId ? { ...x, assignedTo: assigneeName } : x));
  };
  const handleStatus = async (taskId, status) => {
    await TaskLogManager.setTaskStatus?.(taskId, status);
    setTasks(prev => prev.map(x => x.id === taskId ? { ...x, status } : x));
  };

  const tasksFiltered = useMemo(() => {
    if (!showOnlyMine || !meRef.current) return tasks;
    const my = meRef.current.name;
    return tasks.filter(t => t.assignedTo === my || !t.assignedTo);
  }, [tasks, showOnlyMine]);

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold m-0">Household Workboard</h1>
        <Badge>{tasks.length} tasks</Badge>
      </div>

      <Card
        title="Household Pool"
        subtitle="Bedrooms/bathrooms are assigned to occupants. Common areas are distributed evenly with age-appropriate tasks."
        right={<Badge>{pool.length} people</Badge>}
      >
        <div className="flex flex-wrap gap-2 mb-3">
          {pool.map(p => <Badge key={p.id}>{p.name}{typeof p.age === "number" ? ` • ${p.age}` : ""}</Badge>)}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn" onClick={refresh}><span className="label">Rebalance Assignments</span></button>
          <label className="inline-flex items-center gap-2 ml-2">
            <input type="checkbox" className="h-4 w-4" checked={showOnlyMine} onChange={(e)=>setShowOnlyMine(e.target.checked)} />
            <span className="text-sm">Show only my tasks (and unassigned)</span>
          </label>
        </div>
      </Card>

      <Card title="Areas In-House" subtitle="Toggled on because you’ve chosen to insource these areas.">
        <div className="flex flex-wrap gap-2">
          {AREA_OPTIONS.map(opt => {
            const active = enabledAreas.includes(opt.id);
            return (
              <button key={opt.id} type="button" onClick={() => toggleArea(opt.id)} className={`btn sm ${active ? "primary" : ""}`} aria-pressed={active}>
                <span className="label">{opt.icon} {opt.label}</span>
              </button>
            );
          })}
        </div>
      </Card>

      <Card title="Household Tasks" subtitle="Claim tasks or mark them complete as you go.">
        {loading ? (
          <div className="animate-pulse space-y-3 px-1"><div className="h-4 bg-gray-200 rounded" /><div className="h-4 bg-gray-200 rounded" /><div className="h-4 bg-gray-200 rounded w-2/3" /></div>
        ) : tasksFiltered.length === 0 ? (
          <EmptyState icon="🧾" title="No tasks yet" hint="As your automations run (meal plan, cleaning, garden, inventory), tasks will populate here." />
        ) : (
          <ul className="divide-y">
            {tasksFiltered.map(task => (
              <li key={task.id} className="py-3 px-2 md:px-3 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                <div className="flex items-start gap-3">
                  <span className="text-xl">{task.icon || "🧠"}</span>
                  <div>
                    <div className="font-medium">{task.title}</div>
                    <div className="text-sm text-gray-500 space-x-2">
                      <Badge>{task.area}</Badge>
                      {task.room ? <Badge>{task.roomType ? `${task.roomType}: ` : ""}{task.room}</Badge> : null}
                      <span>Priority: {task.priority}</span>
                      {task.estMins ? <span>~{task.estMins} mins</span> : null}
                      {task.dueAt ? <span>Due: {new Date(task.dueAt).toLocaleString()}</span> : null}
                      <span className="text-gray-400">[{task.source}]</span>
                    </div>
                    {task.assignedTo ? <div className="mt-1"><Badge>Assigned: {task.assignedTo}</Badge></div> : <div className="mt-1 text-xs text-gray-500">Unassigned (Household Pool)</div>}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {/* Claim / Reassign */}
                  <select className="select" value={task.assignedTo || ""} onChange={(e)=>handleClaim(task.id, e.target.value || null)} aria-label="Claim task">
                    <option value="">{task.assignedTo ? "Reassign…" : "Claim…"}</option>
                    {pool.map(p => <option key={p.id} value={p.name}>{p.name}</option>)}
                  </select>
                  {/* Status */}
                  <select className="select" value={task.status || "pending"} onChange={(e)=>handleStatus(task.id, e.target.value)} aria-label="Task status">
                    <option value="pending">Pending</option>
                    <option value="in_progress">In progress</option>
                    <option value="completed">Completed</option>
                  </select>
                  <button className="btn" onClick={()=>handleStatus(task.id, "completed")}><span className="label">Log Complete</span></button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

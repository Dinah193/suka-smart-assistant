// C:\Users\larho\suka-smart-assistant\src\layout\Sidebar.jsx
import React, { useEffect, useMemo, useState } from "react";
import {
  Home,
  CalendarDays,
  CookingPot,
  Brush,
  Warehouse,
  Users,
  BadgeCheck,
  Settings,
  Leaf,
  CloudSun,
} from "lucide-react";
import { NavLink, useLocation } from "react-router-dom";

const navItems = [
  { path: "/", label: "Home", icon: <Home size={18} /> },
  { path: "/calendar", label: "Calendar", icon: <CalendarDays size={18} /> },
  {
    path: "/meal-planning",
    label: "Meal Planning",
    icon: <CookingPot size={18} />,
  },
  { path: "/jobs", label: "Jobs", icon: <Brush size={18} /> },
  { path: "/storehouse", label: "Storehouse", icon: <Warehouse size={18} /> },

  // ✅ Keep Homestead Planner button (always visible)
  {
    path: "/homesteadplanner",
    label: "Homestead Planner",
    icon: <Leaf size={18} />,
  },

  { path: "/community", label: "Community", icon: <Users size={18} /> },
  { path: "/badges", label: "Badges", icon: <BadgeCheck size={18} /> },
  { path: "/settings", label: "Settings", icon: <Settings size={18} /> },
];

const cx = (...a) => a.filter(Boolean).join(" ");

function safeGet(obj, path, fallback) {
  try {
    return (
      path.split(".").reduce((acc, k) => (acc ? acc[k] : undefined), obj) ??
      fallback
    );
  } catch {
    return fallback;
  }
}

export default function Sidebar() {
  const location = useLocation();

  // Household identity (best-effort; falls back safely)
  const [householdName, setHouseholdName] = useState("Suka Village");
  const [region, setRegion] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const ProfileStore = await import(
          /* @vite-ignore */ "@/store/ProfileStore"
        ).catch(() => null);
        const st = ProfileStore?.useProfile?.getState?.() || {};
        const name =
          st?.householdName ||
          st?.household?.name ||
          st?.profile?.householdName ||
          st?.name ||
          null;

        const reg = st?.region || st?.profile?.region || null;

        if (!alive) return;
        if (name && typeof name === "string") setHouseholdName(name);
        if (reg && typeof reg === "string") setRegion(reg);
      } catch {
        // ignore
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // “Status line” (lightweight + safe). Uses local time season approximation.
  const seasonLabel = useMemo(() => {
    try {
      const m = new Date().getMonth(); // 0-11
      if (m === 11 || m <= 1) return "Winter mode";
      if (m >= 2 && m <= 4) return "Spring mode";
      if (m >= 5 && m <= 7) return "Summer mode";
      return "Autumn mode";
    } catch {
      return "Household mode";
    }
  }, []);

  const activeLabel = useMemo(() => {
    const p = location?.pathname || "/";
    if (p.startsWith("/homesteadplanner")) return "Homestead planning";
    if (p.startsWith("/meal-planning")) return "Planning meals";
    if (p.startsWith("/jobs") || p.startsWith("/cleaning"))
      return "Household jobs";
    if (p.startsWith("/storehouse")) return "Stocking storehouse";
    if (p.startsWith("/calendar")) return "Calendar & cycles";
    if (p.startsWith("/community")) return "Community";
    if (p.startsWith("/badges")) return "Progress & badges";
    if (p.startsWith("/settings")) return "Settings";
    return "Today’s dashboard";
  }, [location?.pathname]);

  // ✅ Only show nested Homestead items while inside that module
  const isInHomesteadPlanner = useMemo(() => {
    const p = location?.pathname || "/";
    return p === "/homesteadplanner" || p.startsWith("/homesteadplanner/");
  }, [location?.pathname]);

  const homesteadNestedItems = useMemo(
    () => [
      { path: "/homesteadplanner", label: "Overview" },
      { path: "/homesteadplanner/targets", label: "Targets" },
      { path: "/homesteadplanner/components", label: "Components" },
      { path: "/homesteadplanner/inventory", label: "Inventory" },
      { path: "/homesteadplanner/batches", label: "Batches" },
      { path: "/homesteadplanner/garden-targets", label: "Garden Targets" },
      { path: "/homesteadplanner/animal-targets", label: "Animal Targets" },
      { path: "/homesteadplanner/cuisines", label: "Cuisines" },
      { path: "/homesteadplanner/preferences", label: "Preferences" },
      { path: "/homesteadplanner/skills", label: "Skills" },
    ],
    [],
  );

  return (
    <aside className="w-64 h-screen bg-pink-600 text-white flex flex-col shadow-2xl font-sans">
      {/* Household Header */}
      <div className="px-4 py-5 border-b-4 border-pink-200 bg-pink-500">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="text-3xl leading-none">🏡</div>
            <div className="min-w-0">
              <div className="text-[11px] tracking-wide uppercase text-pink-100/90">
                Household
              </div>
              <h1 className="text-xl font-extrabold tracking-wide drop-shadow-sm truncate">
                {householdName}
              </h1>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1 rounded-full bg-white/15 px-2 py-1 text-[11px] font-semibold">
                  <CloudSun size={14} className="opacity-90" />
                  {seasonLabel}
                </span>
                {region ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-white/10 px-2 py-1 text-[11px]">
                    <Leaf size={14} className="opacity-90" />
                    {region}
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        </div>

        {/* Small status line */}
        <div className="mt-3 rounded-xl bg-white/10 border border-white/15 px-3 py-2">
          <div className="text-[11px] text-pink-100/90">Now</div>
          <div className="text-sm font-semibold truncate">{activeLabel}</div>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 py-4 px-2">
        {/* Main */}
        <div className="px-3 mb-2 text-[11px] tracking-wide uppercase text-pink-100/80">
          Main
        </div>
        <div className="space-y-2">
          {navItems.slice(0, 6).map(({ path, label, icon }) => (
            <NavLink
              key={path}
              to={path}
              className={({ isActive }) =>
                cx(
                  "w-full flex items-center gap-4 px-5 py-3 rounded-full text-sm font-bold transition transform",
                  isActive
                    ? "bg-yellow-300 text-pink-700 shadow-md scale-[1.02]"
                    : "bg-white/10 hover:bg-white/20 text-white",
                )
              }
            >
              {icon}
              <span>{label}</span>
            </NavLink>
          ))}

          {/* ✅ Optional nested Homestead items, only visible inside the module */}
          {isInHomesteadPlanner ? (
            <div className="mt-2 ml-4 mr-2 rounded-2xl bg-white/10 border border-white/15 p-2">
              <div className="px-2 py-1 text-[11px] tracking-wide uppercase text-pink-100/80">
                Homestead
              </div>
              <div className="mt-1 space-y-1">
                {homesteadNestedItems.map((it) => (
                  <NavLink
                    key={it.path}
                    to={it.path}
                    className={({ isActive }) =>
                      cx(
                        "w-full flex items-center gap-2 px-3 py-2 rounded-full text-[13px] font-semibold transition",
                        isActive
                          ? "bg-yellow-300 text-pink-700 shadow-sm"
                          : "bg-white/5 hover:bg-white/15 text-white",
                      )
                    }
                  >
                    <span className="opacity-90">•</span>
                    <span className="truncate">{it.label}</span>
                  </NavLink>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        {/* Household */}
        <div className="mt-5 px-3 mb-2 text-[11px] tracking-wide uppercase text-pink-100/80">
          Household
        </div>
        <div className="space-y-2">
          {navItems.slice(6, 7).map(({ path, label, icon }) => (
            <NavLink
              key={path}
              to={path}
              className={({ isActive }) =>
                cx(
                  "w-full flex items-center gap-4 px-5 py-3 rounded-full text-sm font-bold transition transform",
                  isActive
                    ? "bg-yellow-300 text-pink-700 shadow-md scale-[1.02]"
                    : "bg-white/10 hover:bg-white/20 text-white",
                )
              }
            >
              {icon}
              <span>{label}</span>
            </NavLink>
          ))}
        </div>

        {/* Tools */}
        <div className="mt-5 px-3 mb-2 text-[11px] tracking-wide uppercase text-pink-100/80">
          Tools
        </div>
        <div className="space-y-2">
          {navItems.slice(7).map(({ path, label, icon }) => (
            <NavLink
              key={path}
              to={path}
              className={({ isActive }) =>
                cx(
                  "w-full flex items-center gap-4 px-5 py-3 rounded-full text-sm font-bold transition transform",
                  isActive
                    ? "bg-yellow-300 text-pink-700 shadow-md scale-[1.02]"
                    : "bg-white/10 hover:bg-white/20 text-white",
                )
              }
            >
              {icon}
              <span>{label}</span>
            </NavLink>
          ))}
        </div>
      </nav>

      {/* Footer */}
      <div className="text-center text-white text-xs px-4 py-4 italic border-t border-pink-400">
        🍱 Build a joyful & clean home <br />
        with <span className="text-yellow-300 font-bold">love</span> &{" "}
        <span className="text-pink-100 font-bold">order</span>
      </div>
    </aside>
  );
}

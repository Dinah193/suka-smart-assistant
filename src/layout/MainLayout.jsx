// src/layout/MainLayout.jsx
import React from "react";
import { Outlet, useLocation } from "react-router-dom";
import HeaderStats from "./HeaderStats";
import Sidebar from "./Sidebar";

/**
 * Global layout spacing + consistent content container.
 * Goals:
 * - Keep the “homey” gradient frame
 * - Prevent pages from feeling too wide/flat
 * - Standardize inner padding + max-width rhythm across all routes
 * - Slightly tighten/soften spacing so Home matches other pages
 */
export default function MainLayout({ user }) {
  const location = useLocation();
  const isHome = location?.pathname === "/" || location?.pathname === "/home";

  return (
    <div className="flex h-screen bg-gradient-to-tr from-pink-300 via-purple-200 to-yellow-100 text-stone-800 font-sans overflow-hidden">
      {/* 🍽 Sidebar Navigation */}
      <aside className="w-64 bg-white/80 backdrop-bl-sm border-r border-white shadow-xl p-4 rounded-tr-3xl rounded-br-3xl overflow-y-auto">
        <Sidebar />
      </aside>

      {/* 📱 Main Display Area */}
      <main className="flex-1 flex flex-col h-full bg-white rounded-xl m-4 shadow-lg overflow-hidden">
        {/* 🎉 Top Header Stats */}
        <div className="shrink-0">
          <HeaderStats user={user} />
        </div>

        {/* 🧁 Page Content Outlet */}
        <div className="flex-1 overflow-y-auto">
          {/* Unified content frame:
              - max width so pages don’t sprawl
              - consistent padding
              - optional slightly different top spacing for Home */}
          <div className="mx-auto w-full max-w-7xl px-4 md:px-6 lg:px-8 py-5 md:py-8">
            {/* If you want Home to feel a touch more “hero-ish” without changing the page: */}
            {isHome ? <div className="h-1 md:h-2" /> : null}

            <Outlet />
          </div>
        </div>
      </main>
    </div>
  );
}

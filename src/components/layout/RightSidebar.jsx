// src/components/layout/RightSidebar.jsx
import React from "react";
import AdSenseUnit from "@/components/ads/AdSenseUnit";

export default function RightSidebar() {
  return (
    <aside className="w-full lg:w-80 xl:w-96 shrink-0 border-l bg-white">
      <div className="p-4 space-y-6">
        <AdSenseUnit slot="YOUR_SLOT_ID_1" className="w-full" style={{ minHeight: 250 }} />

        {/* In-article / feed-like unit */}
        <AdSenseUnit
          slot="YOUR_SLOT_ID_2"
          className="w-full"
          style={{ minHeight: 200 }}
          format="fluid"
          layout="in-article"
        />

        {/* Another responsive unit */}
        <AdSenseUnit slot="YOUR_SLOT_ID_3" className="w-full" style={{ minHeight: 250 }} />
      </div>
    </aside>
  );
}

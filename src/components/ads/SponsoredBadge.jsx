// src/components/ads/SponsoredBadge.jsx
import React from "react";

export default function SponsoredBadge({ onClick, className = "" }) {
  return (
    <button
      type="button"
      className={[
        "inline-flex items-center gap-2 px-2 py-1 rounded-full text-xs",
        "border border-base-300 bg-base-100 hover:bg-base-200/60",
        "shadow-sm",
        className,
      ].join(" ")}
      onClick={onClick}
      title="Why am I seeing this?"
    >
      <span className="font-semibold">Sponsored</span>
      <span className="opacity-70">•</span>
      <span className="opacity-80 underline">Why?</span>
    </button>
  );
}

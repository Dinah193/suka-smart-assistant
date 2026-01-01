// src/components/ads/AdSenseUnit.jsx
import React, { useEffect, useRef, useMemo } from "react";
import { initAdSense, mountAdSlot } from "@/utils/adsense";

const ENV_CLIENT   = import.meta.env.VITE_ADSENSE_CLIENT;
const ENV_ENABLED  = import.meta.env.VITE_ADSENSE_ENABLED === "true";
const ENV_ADTEST   = import.meta.env.VITE_ADSENSE_TEST === "on";

/**
 * <AdSenseUnit slot="1234567890" format="auto" responsive />
 *
 * Notes:
 * - Uses utils/adsense init+mount (lazy loads; house-ad fallback if blocked).
 * - Pass `meta` to improve house-ad CTA copy & enable "Save as Favorite Plan".
 * - In dev, set VITE_ADSENSE_TEST=on to exercise ad rendering without policy risk.
 */
export default function AdSenseUnit({
  client     = ENV_CLIENT,      // "ca-pub-xxxx"
  enabled    = ENV_ENABLED,     // gate in prod
  slot,                          // your slot id (string). Leave undefined to let AdSense pick.
  format     = "auto",
  responsive = true,
  layout,                        // optional AdSense layout
  layoutKey,                     // optional AdSense layout key
  className  = "",
  style      = { minHeight: 120 },
  meta       = {},               // { domain, tags, planTitle, planId, title, desc }
}) {
  const allow = enabled || ENV_ADTEST;
  const containerRef = useRef(null);

  // House-ad metadata defaults so the fallback always adds value
  const houseMeta = useMemo(() => ({
    domain: "meals",
    tags: ["evergreen"],
    title: "Make life easier with a Favorite Plan",
    desc:  "Save your best runbooks to reuse—meals, cleaning, garden, and animals.",
    planTitle: "My Favorite Plan",
    ...meta,
  }), [meta]);

  useEffect(() => {
    if (!allow) return;
    if (typeof window === "undefined") return;

    // One-time init (noop if already injected)
    initAdSense({
      clientId: client,
      lazy: true,
      blockForPremium: true, // respect premium/ad-free users
      respectDNT: true,      // respect Do-Not-Track
    });

    if (!containerRef.current) return;

    const { unmount } = mountAdSlot(containerRef.current, {
      format,
      responsive,
      layoutKey,
      style: { display: "block", ...style },
      slotId: slot,
      meta: houseMeta,                    // used by utils to render house ad fallback
      adTest: ENV_ADTEST,                 // "data-adtest"
    });

    // Cleanup on unmount/route change
    return () => { try { unmount?.(); } catch {} };
  }, [allow, client, slot, format, responsive, layoutKey, style, houseMeta]);

  // Disabled → keep layout stable with a light skeleton (no network)
  if (!allow) {
    return (
      <div
        className={`rounded-xl border bg-stone-50/60 animate-pulse ${className}`}
        style={{ height: style?.minHeight ?? 120, ...style }}
        aria-hidden
        data-testid="adsense-skeleton"
      />
    );
  }

  // The utils will create <ins class="adsbygoogle"> inside this container.
  return <div ref={containerRef} className={className} style={style} data-testid="adsense-slot" />;
}

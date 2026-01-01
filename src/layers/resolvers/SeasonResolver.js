/**
 * File: src/layers/resolvers/SeasonResolver.js
 * Purpose: Determine seasonal tags + variant flags + constraint tags.
 *
 * Inputs:
 *  - dateISO: string (YYYY-MM-DD) or Date
 *  - zone: string | null (e.g., "7b") optional
 *  - opts: { hemisphere?: "north"|"south", seasonalMode?: string, hebrew?: { monthKey?: string, day?: number }, feastCounting?: { shavuotRuleId?: string } }
 *  - seasonalCatalogs: { seasons, zones, feastWindows } (JSON loaded by LayerAssetLoader)
 *
 * Output:
 *  - { tags: string[], variantFlags: object, constraints: string[], feastTags: string[], debug: object }
 */

import { safeArray, normalizeText, uniq } from "./_resolverUtils.js";

function parseMonthDay(dateISO) {
  const d = (dateISO instanceof Date) ? dateISO : new Date(String(dateISO));
  if (Number.isNaN(d.getTime())) return null;
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}-${dd}`;
}

function boundaryToMonthDay(boundaries, id) {
  const b = (boundaries || []).find(x => x.id === id);
  return b?.approxMonthDay || null;
}

function inRangeMD(md, start, end) {
  // md, start, end are MM-DD. Handles wrap-around (e.g., winter: 12-21 to 03-20)
  if (!md || !start || !end) return false;
  if (start <= end) return md >= start && md < end;
  // wrap
  return md >= start || md < end;
}

function determineSeason(seasonsCatalog, md, hemisphere = "north") {
  const boundaries = seasonsCatalog?.boundaries || [];
  const seasons = seasonsCatalog?.seasons || [];

  // For southern hemisphere, swap seasons by 6 months (roughly).
  // We do this by mapping tags: winter<->summer, spring<->fall
  const swap = hemisphere === "south";
  const seasonMap = (tag) => {
    if (!swap) return tag;
    if (tag === "season:winter") return "season:summer";
    if (tag === "season:summer") return "season:winter";
    if (tag === "season:spring") return "season:fall";
    if (tag === "season:fall") return "season:spring";
    return tag;
  };

  for (const s of seasons) {
    const start = boundaryToMonthDay(boundaries, s.startBoundary);
    const end = boundaryToMonthDay(boundaries, s.endBoundary);
    if (inRangeMD(md, start, end)) {
      return { seasonTag: seasonMap(s.tag), seasonId: s.id, triggers: s.planningTriggers || [], constraints: s.typicalConstraints || [] };
    }
  }
  // fallback
  return { seasonTag: seasonMap("season:unknown"), seasonId: "unknown", triggers: [], constraints: [] };
}

function zoneTags(zoneCatalog, zone) {
  const z = normalizeText(zone || "");
  if (!z) return ["zone:unknown"];
  const rec = (zoneCatalog?.zones || []).find(x => normalizeText(x.zone) === z);
  return rec?.tags || ["zone:unknown"];
}

function feastTags(feastCatalog, hebrew = {}, feastCounting = {}) {
  // If hebrew month/day not available, return empty list.
  const mk = normalizeText(hebrew?.monthKey);
  const day = Number(hebrew?.day);
  if (!mk || !Number.isFinite(day)) return [];

  const out = [];
  for (const w of (feastCatalog?.windows || [])) {
    if (w.monthKey && normalizeText(w.monthKey) !== mk) continue;
    if (Number.isFinite(w.startDay) && Number.isFinite(w.endDay)) {
      if (day >= w.startDay && day <= w.endDay) out.push(w.tag);
      for (const a of (w.anchors || [])) {
        if (a.day === day) out.push(a.tag);
      }
    }
    // shavuot is relative; only emit if already computed upstream and passed in
    if (w.relativeTo === "firstfruits") {
      // upstream can pass hebrew.feastTagsComputed containing feast:shavuot
      const computed = safeArray(hebrew?.feastTagsComputed);
      for (const t of computed) out.push(String(t));
    }
  }
  return uniq(out);
}

export class SeasonResolver {
  constructor(opts = {}) {
    this.catalogs = opts.catalogs || null; // optional default catalogs
  }

  resolve(dateISO, zone = null, opts = {}, catalogsOverride = null) {
    const catalogs = catalogsOverride || this.catalogs || {};
    const seasonsCatalog = catalogs.seasons || {};
    const zoneCatalog = catalogs.zones || {};
    const feastCatalog = catalogs.feastWindows || {};

    const hemisphere = opts.hemisphere || seasonsCatalog?.defaults?.hemisphere || "north";
    const seasonalMode = opts.seasonalMode || "default";
    const md = parseMonthDay(dateISO);

    const s = determineSeason(seasonsCatalog, md, hemisphere);
    const ztags = zoneTags(zoneCatalog, zone);
    const ftags = feastTags(feastCatalog, opts.hebrew || {}, opts.feastCounting || {});

    const tags = uniq([s.seasonTag, ...ztags, ...ftags, `seasonMode:${seasonalMode}`].filter(Boolean));
    const constraints = uniq([...(s.constraints || []), ...ztags.filter(t => t.includes("freeze:") || t.includes("heat:")).map(t => `constraint:${t}`)]);

    const variantFlags = {
      seasonId: s.seasonId,
      seasonTag: s.seasonTag,
      hemisphere,
      seasonalMode,
      hasFeastContext: ftags.length > 0,
    };

    return {
      tags,
      variantFlags,
      constraints,
      feastTags: ftags,
      debug: { md, triggers: s.triggers || [], zone, zoneTags: ztags }
    };
  }
}

export default SeasonResolver;

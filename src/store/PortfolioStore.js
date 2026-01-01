// src/store/PortfolioStore.js
import { create } from "zustand";
import { persist } from "zustand/middleware";

/* ----------------------- Calendar + rhythm normalization ------------------- */
const CAL_GREG = "gregorian";
const CAL_HEB = "hebrew";
const CAL_CRE = "creation";

const GREG_KEYS = ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"];
const HEB_KEYS  = ["yom_rishon","yom_sheni","yom_shelishi","yom_revi_i","yom_chamishi","yom_shishi","shabbat"];
const CRE_KEYS  = ["day_one","day_two","day_three","day_four","day_five","day_six","sabbath"];
const POS = { [CAL_GREG]: GREG_KEYS, [CAL_HEB]: HEB_KEYS, [CAL_CRE]: CRE_KEYS };

function detectCalendar(map = {}) {
  const has = (ks) => ks.some((k) => Array.isArray(map?.[k]));
  if (has(HEB_KEYS)) return CAL_HEB;
  if (has(CRE_KEYS)) return CAL_CRE;
  return CAL_GREG;
}
function normalizeTo(calendar, src = {}) {
  const out = {};
  (POS[calendar] || GREG_KEYS).forEach((k) => { out[k] = Array.isArray(src[k]) ? [...src[k]] : []; });
  return out;
}
function rhythmToGregorian(map = {}) {
  const cal = detectCalendar(map);
  if (cal === CAL_GREG) return normalizeTo(CAL_GREG, map);
  const src = normalizeTo(cal, map);
  const out = {};
  for (let i = 0; i < 7; i++) out[GREG_KEYS[i]] = [...(src[POS[cal][i]] || [])];
  return out;
}

/* -------------------------- Text + similarity helpers --------------------- */
const lc = (s) => String(s || "").toLowerCase();
function tokenize(s) {
  return lc(s).replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter(Boolean);
}
function shingles(tokens, size = 2) {
  const out = new Set();
  for (let i = 0; i <= tokens.length - size; i++) out.add(tokens.slice(i, i + size).join(" "));
  return out;
}
function jaccard(a, b) {
  if (!a.size && !b.size) return 0;
  let inter = 0;
  a.forEach((x) => { if (b.has(x)) inter++; });
  return inter / (a.size + b.size - inter || 1);
}

/* ----------------------------- Uniqueness scoring ------------------------- */
/**
 * Compute a 0–100 uniqueness score for a candidate portfolio against:
 *  - existing recipe packs (from dynamic listPacks import)
 *  - published portfolios in our store
 *
 * Intuition:
 *  - Start with 1 - max textual similarity (title+desc+tags) vs corpus
 *  - Add flavor novelty bonus
 *  - Add small rhythm bonus (if selected days cover ≥ 3 distinct flavors)
 *  - Clamp 0..100
 */
async function computeUniquenessAgainstCorpus(candidate, publishedRecords) {
  // lazy-load pack manifests to avoid bundling cost
  let manifests = [];
  try {
    const mod = await import("@/data/recipe-packs");
    manifests = await mod.listPacks({ vision: null });
  } catch {
    // ignore; offline or path changed — we'll use only publishedRecords
  }

  // Build corpus entries: { title, description, tags, flavors }
  const corpus = [
    ...manifests.map((m) => ({
      title: m.title, description: m.description, tags: m.tags || [], flavors: m.flavors || [],
    })),
    ...(publishedRecords || []).map((r) => ({
      title: r.title, description: r.description || "", tags: r.tags || [], flavors: r.flavors || [],
    })),
  ];

  // Candidate text
  const textCand = `${candidate.title || ""} ${candidate.description || ""} ${(candidate.tags || []).join(" ")}`;
  const tokCand = tokenize(textCand);
  const shingles2 = shingles(tokCand, 2);
  const shingles3 = shingles(tokCand, 3);

  // Compare to corpus: max of combined similarity (avg of 2-gram, 3-gram)
  let maxSim = 0;
  for (const c of corpus) {
    const textC = `${c.title || ""} ${c.description || ""} ${(c.tags || []).join(" ")}`;
    const tokC = tokenize(textC);
    const s2 = shingles(tokC, 2);
    const s3 = shingles(tokC, 3);
    const sim = 0.5 * jaccard(shingles2, s2) + 0.5 * jaccard(shingles3, s3);
    if (sim > maxSim) maxSim = sim;
  }

  // Base uniqueness from text
  let score = (1 - Math.min(1, maxSim)) * 100;

  // Flavor novelty bonus (compare sets)
  const candFlavors = new Set((candidate.flavor_profile || []).map((f) => lc(f)));
  if (candFlavors.size) {
    let bestFlavorOverlap = 0;
    for (const c of corpus) {
      const cf = new Set((c.flavors || []).map((f) => lc(f)));
      const inter = [...candFlavors].filter((f) => cf.has(f)).length;
      const union = candFlavors.size + cf.size - inter;
      const overlap = union ? inter / union : 0;
      if (overlap > bestFlavorOverlap) bestFlavorOverlap = overlap;
    }
    const novelty = 1 - bestFlavorOverlap; // 0..1
    score += novelty * 15; // up to +15 for flavor novelty
  }

  // Rhythm novelty bonus: if ≥3 days set and ≥3 unique flavors used in rhythm, +5
  const g = rhythmToGregorian(candidate.weeklyFlavorRhythm || {});
  const uniqueRhythmFlavors = new Set();
  Object.values(g).forEach((arr) => (arr || []).forEach((f) => uniqueRhythmFlavors.add(lc(f))));
  const daysWithFlavors = Object.values(g).filter((arr) => (arr || []).length > 0).length;
  if (daysWithFlavors >= 3 && uniqueRhythmFlavors.size >= 3) score += 5;

  // Clamp
  return Math.max(0, Math.min(100, Math.round(score)));
}

/* ---------------------------------- Types ---------------------------------- */
/**
 * @typedef {Object} Portfolio
 * @property {string} id
 * @property {string} title
 * @property {string} [description]
 * @property {string[]} [tags]
 * @property {string[]} [flavor_profile]
 * @property {Object.<string, string[]>} [weeklyFlavorRhythm] // stored as provided (Gregorian/Hebrew/Creation); normalized when needed
 * @property {"private"|"family"|"public"} [visibility]
 * @property {string} [cover]
 * @property {number} [uniquenessScore] // 0..100
 * @property {number} [updatedAt]
 */

/* --------------------------------- The store -------------------------------- */
export const usePortfolios = create(
  persist(
    (set, get) => ({
      /** @type {Record<string, Portfolio>} */
      portfolios: {},
      /** Minimal marketplace index of published portfolios */
      marketplace: [], // [{id,title,visibility,cover,flavors,tags,description,uniquenessScore,updatedAt}]

      /* ------------------------------- CRUD -------------------------------- */
      upsertPortfolio: (p) => {
        const id = p?.id;
        if (!id) return;
        const current = get().portfolios[id] || {};
        const merged = {
          ...current,
          ...p,
          updatedAt: Date.now(),
        };
        set((s) => ({ portfolios: { ...s.portfolios, [id]: merged } }));
        return merged;
      },
      setVisibility: (id, visibility) => {
        const current = get().portfolios[id];
        if (!current) return;
        get().upsertPortfolio({ ...current, visibility });
      },
      setWeeklyFlavorRhythm: (id, rhythm) => {
        const current = get().portfolios[id] || { id, visibility: "private" };
        get().upsertPortfolio({ ...current, weeklyFlavorRhythm: rhythm });
      },
      removePortfolio: (id) => {
        set((s) => {
          const next = { ...s.portfolios };
          delete next[id];
          return { portfolios: next };
        });
      },

      /* ---------------------- Derived + selectors -------------------------- */
      getPortfolio: (id) => get().portfolios[id] || null,
      getWeeklyFlavorRhythm: (id) => (get().portfolios[id]?.weeklyFlavorRhythm) || {},

      /* -------------------------- Uniqueness logic ------------------------- */
      computeUniquenessScore: async (id) => {
        const p = get().portfolios[id];
        if (!p) return 0;

        const published = get().marketplace || [];
        const score = await computeUniquenessAgainstCorpus(p, published);
        // Persist on the portfolio
        get().upsertPortfolio({ ...p, uniquenessScore: score });
        return score;
      },

      recomputeAllUniqueness: async () => {
        const ids = Object.keys(get().portfolios);
        for (const id of ids) {
          // eslint-disable-next-line no-await-in-loop
          await get().computeUniquenessScore(id);
        }
      },

      isMarketplaceEligible: (id) => {
        const p = get().portfolios[id];
        if (!p) return false;
        const score = typeof p.uniquenessScore === "number" ? p.uniquenessScore : 0;
        return Boolean(p.title && p.visibility === "public" && score >= 30);
      },

      /* ------------------------------ Publish ------------------------------ */
      publishToMarketplace: async (id) => {
        const p = get().portfolios[id];
        if (!p) throw new Error("Portfolio not found.");

        // Ensure score
        const score = typeof p.uniquenessScore === "number"
          ? p.uniquenessScore
          : await get().computeUniquenessScore(id);

        if (!(p.title && p.visibility === "public" && score >= 30)) {
          throw new Error("Not eligible for marketplace (needs title, Public visibility, uniqueness ≥ 30%).");
        }

        // Basic uniqueness check against file-based packs & marketplace IDs/titles
        let manifests = [];
        try {
          const mod = await import("@/data/recipe-packs");
          manifests = await mod.listPacks({ vision: null });
        } catch { /* ignore offline */ }

        const titleLC = lc(p.title);
        const idLC = lc(p.id);
        const clashes = [];

        manifests.forEach((m) => {
          if (lc(m.id) === idLC) clashes.push({ kind: "id", with: m.id });
          if (lc(m.title) === titleLC) clashes.push({ kind: "title", with: m.title });
        });
        (get().marketplace || []).forEach((r) => {
          if (lc(r.id) === idLC) clashes.push({ kind: "id", with: r.id });
          if (lc(r.title) === titleLC) clashes.push({ kind: "title", with: r.title });
        });
        if (clashes.length) {
          const msg = clashes.map(c => (c.kind === "id" ? `ID "${c.with}"` : `Title "${c.with}"`)).join(", ");
          throw new Error(`Uniqueness check failed: ${msg}`);
        }

        // Write record
        const record = {
          id: p.id,
          title: p.title,
          visibility: p.visibility,
          cover: p.cover || null,
          flavors: p.flavor_profile || [],
          tags: p.tags || [],
          description: p.description || "",
          uniquenessScore: score,
          updatedAt: Date.now(),
        };
        set((s) => ({
          marketplace: [record, ...(s.marketplace || []).filter((r) => r.id !== record.id)],
        }));
        return record;
      },
    }),
    {
      name: "suka:portfolio-store",
      version: 1,
      // simple migration keepers if you rev shapes later
      migrate: (persisted, version) => persisted,
      partialize: (state) => ({
        portfolios: state.portfolios,
        marketplace: state.marketplace,
      }),
    }
  )
);

/* ------------------------------- Convenience ------------------------------- */
export const PortfolioStore = {
  usePortfolios,
  // Selectors (handy in React components)
  useById: (id) => usePortfolios((s) => s.portfolios[id]),
  useWeeklyRhythmById: (id) => usePortfolios((s) => s.portfolios[id]?.weeklyFlavorRhythm || {}),
  // Imperative helpers
  upsert: (p) => usePortfolios.getState().upsertPortfolio(p),
  setVisibility: (id, v) => usePortfolios.getState().setVisibility(id, v),
  setWeeklyFlavorRhythm: (id, r) => usePortfolios.getState().setWeeklyFlavorRhythm(id, r),
  computeUniquenessScore: (id) => usePortfolios.getState().computeUniquenessScore(id),
  isMarketplaceEligible: (id) => usePortfolios.getState().isMarketplaceEligible(id),
  publish: (id) => usePortfolios.getState().publishToMarketplace(id),
};

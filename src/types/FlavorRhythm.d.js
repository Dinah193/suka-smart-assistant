// src/types/FlavorRhythm.d.js
// -----------------------------------------------------------------------------
// Weekly Flavor Rhythm — Default: Day One → Sabbath (English labels)
// Optional label style: ancient Scriptural transliteration (Yom Echad … Shabbat)
// Dynamic flavor discovery from VISION_PRESETS (no hard-coded palettes)
// -----------------------------------------------------------------------------

import { VISION_PRESETS } from "@/data/visionPresets";

/* =============================================================================
   TYPES (JSDoc so you get intellisense in JS)
============================================================================= */

/**
 * Gregorian map (requested shape for compatibility).
 * @typedef {Object} FlavorDayMap
 * @property {string[]=} monday
 * @property {string[]=} tuesday
 * @property {string[]=} wednesday
 * @property {string[]=} thursday
 * @property {string[]=} friday
 * @property {string[]=} saturday
 * @property {string[]=} sunday
 */

/** Optional: static fallback list (kept alongside dynamic discovery). */
export const FLAVOR_OPTIONS = [
  "Soul Food","Caribbean","West African","Cajun","Creole",
  "Mediterranean","BBQ","Herb-Garlic","Citrus-Chili","Asian Fusion",
];

/* =============================================================================
   SCHEMES, KEYS & LABELS
============================================================================= */

export const RHYTHM_SCHEME = {
  CREATION: "creation",   // day_one → sabbath (DEFAULT)
  GREGORIAN: "gregorian", // monday → sunday
};

/** Creation-order canonical keys (stable internal keys) */
export const DAY_KEYS_CREATION = [
  "day_one",
  "day_two",
  "day_three",
  "day_four",
  "day_five",
  "day_six",
  "sabbath",
];

/** Default UI labels (English) — Day 1 → Sabbath */
export const DAY_LABELS_EN = {
  day_one:   "Day One",
  day_two:   "Day Two",
  day_three: "Day Three",
  day_four:  "Day Four",
  day_five:  "Day Five",
  day_six:   "Day Six (Preparation Day)",
  sabbath:   "Sabbath",
};

/** Ancient Scriptural transliterations (no modern/Yiddish terms) */
export const DAY_LABELS_ANCIENT = {
  day_one:   "Yom Echad (Day One)",
  day_two:   "Yom Sheni (Day Two)",
  day_three: "Yom Shlishi (Day Three)",
  day_four:  "Yom Revi’i (Day Four)",
  day_five:  "Yom Chamishi (Day Five)",
  day_six:   "Yom Shishi (Day Six / Preparation)",
  sabbath:   "Shabbat (Sabbath)",
};

/** Gregorian keys (Monday-first for consistent UI sorting) */
export const DAY_KEYS_GREGORIAN = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

/** Choose keys for a scheme */
export function getDayKeys(scheme = RHYTHM_SCHEME.CREATION) {
  return scheme === RHYTHM_SCHEME.GREGORIAN ? DAY_KEYS_GREGORIAN : DAY_KEYS_CREATION;
}

/** Choose labels for Creation scheme (English default; or Ancient) */
export function getCreationLabels(style = "english") {
  return style === "ancient" ? DAY_LABELS_ANCIENT : DAY_LABELS_EN;
}

/* =============================================================================
   RHYTHM NORMALIZATION & RESOLUTION
============================================================================= */

/** Empty rhythm for the given scheme */
export function defaultRhythm(scheme = RHYTHM_SCHEME.CREATION) {
  const out = {};
  for (const k of getDayKeys(scheme)) out[k] = [];
  return out;
}

/** Normalize arbitrary input into full { dayKey: string[] } for the scheme */
export function normalizeRhythm(input, scheme = RHYTHM_SCHEME.CREATION) {
  const out = {};
  const src = (input && typeof input === "object") ? input : {};
  for (const k of getDayKeys(scheme)) {
    const raw = src[k];
    if (Array.isArray(raw)) {
      out[k] = [...new Set(raw.map(x => String(x).trim()).filter(Boolean))];
    } else if (typeof raw === "string" && raw.trim()) {
      out[k] = [raw.trim()];
    } else {
      out[k] = [];
    }
  }
  return out;
}

/**
 * Resolve scheme (Creation default; flip to Gregorian if a user flag is set).
 * Expect a vision flag like: vision.useGregorianRhythm === true
 */
export function resolveScheme({ vision, override } = {}) {
  if (override) return override;
  if (vision?.useGregorianRhythm) return RHYTHM_SCHEME.GREGORIAN;
  return RHYTHM_SCHEME.CREATION;
}

/**
 * Resolve Creation label style.
 * - "english" (default): Day One … Sabbath
 * - "ancient": Yom Echad … Shabbat (scriptural transliteration)
 * Expect a vision flag like: vision.dayLabelStyle = "ancient"
 */
export function resolveCreationLabelStyle({ vision, override } = {}) {
  if (override === "english" || override === "ancient") return override;
  return vision?.dayLabelStyle === "ancient" ? "ancient" : "english";
}

/* =============================================================================
   DATE HELPERS
============================================================================= */

/** Map a Date → canonical day key for the selected scheme */
export function todayKey(date = new Date(), scheme = RHYTHM_SCHEME.CREATION) {
  if (scheme === RHYTHM_SCHEME.GREGORIAN) {
    // JS: 0=Sun..6=Sat → Monday-first index mapping
    const jsIdx = date.getDay();
    const mondayFirst = [6,0,1,2,3,4,5]; // Sun→6, Mon→0
    return DAY_KEYS_GREGORIAN[mondayFirst[jsIdx]];
  }
  // Creation rhythm: Sun..Sat → Day One..Sabbath
  const idx = date.getDay(); // 0..6
  return DAY_KEYS_CREATION[idx] ?? DAY_KEYS_CREATION[0];
}

/** Get flavors for a given date from a rhythm map */
export function getFlavorsForDate(rhythm, date = new Date(), scheme = RHYTHM_SCHEME.CREATION) {
  const key = todayKey(date, scheme);
  const arr = rhythm?.[key] || [];
  return Array.isArray(arr) ? arr : [];
}

/* =============================================================================
   DYNAMIC FLAVOR DISCOVERY (from presets)
============================================================================= */

function extractFlavorsFromPreset(preset) {
  const bag = new Set();

  const candidates = [
    ...(preset?.flavor_palette || []),
    ...(preset?.flavors || []),
    ...(preset?.tags?.flavors || []),
    ...(preset?.labels?.flavors || []),
  ];

  const textish = [
    ...(preset?.goals || []),
    ...(preset?.constraints || []),
    ...(preset?.dietary || []),
    ...(preset?.mode || []),
    typeof preset?.description === "string" ? preset.description : "",
    typeof preset?.title === "string" ? preset.title : "",
  ].filter(Boolean).map(String);

  textish.forEach((t) => {
    t.split(/[;,]/g).forEach((chunk) => {
      const s = chunk.trim();
      if (s && /[A-Za-z]/.test(s) && s.length <= 48) bag.add(s);
    });
  });

  candidates.forEach((c) => {
    const s = String(c).trim();
    if (s) bag.add(s);
  });

  // Title-case cleanup & dedupe
  const byKey = new Map();
  Array.from(bag).forEach((s) => {
    const title = s
      .toLowerCase()
      .split(" ")
      .map((w) => (w.length ? w[0].toUpperCase() + w.slice(1) : w))
      .join(" ");
    byKey.set(title.toLowerCase(), title);
  });

  return Array.from(byKey.values());
}

/** Collect dynamic flavor options from all presets (fallback to FLAVOR_OPTIONS) */
export function collectFlavorOptions(presets = VISION_PRESETS) {
  const all = new Set();
  const values = presets && typeof presets === "object" ? Object.values(presets) : [];
  values.forEach((p) => extractFlavorsFromPreset(p).forEach((f) => all.add(f)));
  const arr = Array.from(all).sort((a, b) => a.localeCompare(b));
  return arr.length ? arr : [...FLAVOR_OPTIONS];
}

/**
 * Suggest a compact list for pickers:
 *  1) From active preset
 *  2) From user Vision text (goals/constraints/dietary/mode)
 *  3) From global preset-derived options (with fallback)
 */
export function suggestFlavorOptions({ presetKey, vision, presets = VISION_PRESETS, max } = {}) {
  const out = new Set();

  if (presetKey && presets?.[presetKey]) {
    extractFlavorsFromPreset(presets[presetKey]).forEach((f) => out.add(f));
  }

  const text = [
    ...(vision?.goals || []),
    ...(vision?.constraints || []),
    ...(vision?.dietary || []),
    ...(vision?.mode || []),
  ].filter(Boolean).map(String).join(" ; ");

  text.split(/[;,]/g).forEach((chunk) => {
    const s = chunk.trim();
    if (s && /[A-Za-z]/.test(s) && s.length <= 48) {
      const title = s.toLowerCase().split(" ")
        .map((w) => (w.length ? w[0].toUpperCase() + w.slice(1) : w))
        .join(" ");
      out.add(title);
    }
  });

  collectFlavorOptions(presets).forEach((f) => out.add(f));

  const arr = Array.from(out).sort((a, b) => a.localeCompare(b));
  return typeof max === "number" && max > 0 ? arr.slice(0, max) : arr;
}

/* =============================================================================
   PRESET RHYTHM & MERGE
============================================================================= */

export function defaultRhythmFromPresetKey(
  presetKey,
  scheme = RHYTHM_SCHEME.CREATION,
  presets = VISION_PRESETS
) {
  const p = presets?.[presetKey];
  if (!p) return defaultRhythm(scheme);
  // Presets can store "weeklyFlavorRhythm" using creation keys; normalize it.
  const candidate = p.weeklyFlavorRhythm || {};
  return normalizeRhythm(candidate, scheme);
}

export function mergeRhythms(presetRhythm, userRhythm, scheme = RHYTHM_SCHEME.CREATION) {
  const base = defaultRhythm(scheme);
  const inputs = [presetRhythm || {}, userRhythm || {}];
  for (const r of inputs) {
    const norm = normalizeRhythm(r, scheme);
    for (const k of getDayKeys(scheme)) {
      if (Array.isArray(norm[k])) {
        base[k] = [...new Set([...(base[k] || []), ...norm[k]])];
      }
    }
  }
  return base;
}

/** Effective rhythm = preset rhythm → overlaid with user rhythm (normalized) */
export function effectiveRhythm(
  vision,
  presetKey,
  scheme = RHYTHM_SCHEME.CREATION,
  presets = VISION_PRESETS
) {
  const presetRh = defaultRhythmFromPresetKey(presetKey, scheme, presets);
  const userRh  = normalizeRhythm(vision?.weeklyFlavorRhythm || {}, scheme);
  return mergeRhythms(presetRh, userRh, scheme);
}

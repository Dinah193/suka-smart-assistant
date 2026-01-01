// src/components/meals/PlanPretty.jsx
import React, { useMemo } from "react";

/* -------------------------- Day key dictionaries -------------------------- */
const CAL_GREG = "gregorian";
const CAL_HEB = "hebrew";
const CAL_CRE = "creation";

const GREG_KEYS = ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"];
const HEB_KEYS  = ["yom_rishon","yom_sheni","yom_shelishi","yom_revi_i","yom_chamishi","yom_shishi","shabbat"];
const CRE_KEYS  = ["day_one","day_two","day_three","day_four","day_five","day_six","sabbath"];

const LABELS = {
  [CAL_GREG]: {
    monday: "Monday", tuesday: "Tuesday", wednesday: "Wednesday",
    thursday: "Thursday", friday: "Friday", saturday: "Saturday", sunday: "Sunday",
  },
  [CAL_HEB]: {
    yom_rishon: "Yom Rishon (Sun)", yom_sheni: "Yom Sheni (Mon)", yom_shelishi: "Yom Shelishi (Tue)",
    yom_revi_i: "Yom Revi’i (Wed)", yom_chamishi: "Yom Chamishi (Thu)", yom_shishi: "Yom Shishi (Fri)", shabbat: "Shabbat (Sat)",
  },
  [CAL_CRE]: {
    day_one: "Day One", day_two: "Day Two", day_three: "Day Three",
    day_four: "Day Four", day_five: "Day Five", day_six: "Day Six", sabbath: "Sabbath",
  },
};

/* ----------------------------- Day recognition ---------------------------- */
function detectCalendarKey(str = "") {
  const id = String(str).trim().toLowerCase();
  if (GREG_KEYS.includes(id)) return { cal: CAL_GREG, key: id, label: LABELS[CAL_GREG][id] };
  if (HEB_KEYS.includes(id))  return { cal: CAL_HEB,  key: id, label: LABELS[CAL_HEB][id] };
  if (CRE_KEYS.includes(id))  return { cal: CAL_CRE,  key: id, label: LABELS[CAL_CRE][id] };

  // English names → Gregorian
  const englishToGreg = {
    mon: "monday", monday: "monday",
    tue: "tuesday", tues: "tuesday", tuesday: "tuesday",
    wed: "wednesday", weds: "wednesday", wednesday: "wednesday",
    thu: "thursday", thur: "thursday", thurs: "thursday", thursday: "thursday",
    fri: "friday", friday: "friday",
    sat: "saturday", saturday: "saturday",
    sun: "sunday", sunday: "sunday",
  };
  if (englishToGreg[id]) {
    const k = englishToGreg[id];
    return { cal: CAL_GREG, key: k, label: LABELS[CAL_GREG][k] };
  }

  // fuzzy Hebrew/Creation partials
  if (id.includes("revi"))    return { cal: CAL_HEB, key: "yom_revi_i", label: LABELS[CAL_HEB]["yom_revi_i"] };
  if (id.includes("shishi"))  return { cal: CAL_HEB, key: "yom_shishi", label: LABELS[CAL_HEB]["yom_shishi"] };
  if (id.includes("rishon"))  return { cal: CAL_HEB, key: "yom_rishon", label: LABELS[CAL_HEB]["yom_rishon"] };
  if (id.includes("sheni"))   return { cal: CAL_HEB, key: "yom_sheni", label: LABELS[CAL_HEB]["yom_sheni"] };
  if (id.includes("shelishi"))return { cal: CAL_HEB, key: "yom_shelishi", label: LABELS[CAL_HEB]["yom_shelishi"] };
  if (id.includes("chamishi"))return { cal: CAL_HEB, key: "yom_chamishi", label: LABELS[CAL_HEB]["yom_chamishi"] };
  if (id.includes("shabbat")) return { cal: CAL_HEB, key: "shabbat", label: LABELS[CAL_HEB]["shabbat"] };

  if (id.includes("day_one"))   return { cal: CAL_CRE, key: "day_one", label: LABELS[CAL_CRE]["day_one"] };
  if (id.includes("day_two"))   return { cal: CAL_CRE, key: "day_two", label: LABELS[CAL_CRE]["day_two"] };
  if (id.includes("day_three")) return { cal: CAL_CRE, key: "day_three", label: LABELS[CAL_CRE]["day_three"] };
  if (id.includes("day_four"))  return { cal: CAL_CRE, key: "day_four", label: LABELS[CAL_CRE]["day_four"] };
  if (id.includes("day_five"))  return { cal: CAL_CRE, key: "day_five", label: LABELS[CAL_CRE]["day_five"] };
  if (id.includes("day_six"))   return { cal: CAL_CRE, key: "day_six", label: LABELS[CAL_CRE]["day_six"] };
  if (id.includes("sabbath"))   return { cal: CAL_CRE, key: "sabbath", label: LABELS[CAL_CRE]["sabbath"] };

  // default
  return { cal: CAL_GREG, key: "monday", label: "Monday" };
}

/* ------------------------------ Flavor helpers ----------------------------- */
function extractMealFlavors(meal) {
  if (!meal) return [];
  const out = new Set();

  // flavor_profile: "Caribbean" | ["Caribbean","BBQ"]
  const fp = meal.flavor_profile;
  if (typeof fp === "string" && fp.trim()) out.add(fp.trim());
  if (Array.isArray(fp)) fp.filter(Boolean).forEach((t) => out.add(String(t).trim()));

  // tags: ["flavor:Caribbean", "flavor:BBQ"]
  const tags = Array.isArray(meal.tags) ? meal.tags : [];
  tags.forEach((t) => {
    const m = String(t).match(/^flavor\s*:\s*(.+)$/i);
    if (m && m[1]) out.add(m[1].trim());
  });

  return Array.from(out);
}

function aggregateDayFlavors(day) {
  const meals = Array.isArray(day?.meals) ? day.meals : [];
  const set = new Set();
  meals.forEach((m) => extractMealFlavors(m).forEach((f) => set.add(f)));
  return Array.from(set);
}

/* ----------------------------- “Today” detection ---------------------------- */
function isSameDate(a, b) {
  if (!a || !b) return false;
  const da = new Date(a), db = new Date(b);
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
}

/**
 * Returns true if this card represents "today".
 * Priority:
 * 1) If day.date exists and matches today’s date.
 * 2) Else compare by weekday name (Gregorian) vs today’s weekday.
 */
function isTodayCard(day) {
  const now = new Date();
  if (day?.date && (isSameDate(day.date, now) || isSameDate(day?.meta?.date, now))) return true;

  // by name
  const todayGregIdx = (now.getDay() + 6) % 7; // Mon=0 .. Sun=6
  const todayKey = GREG_KEYS[todayGregIdx];
  const id = detectCalendarKey(day?.day || day?.name || day?.id || "");
  // Map each calendar’s position to Gregorian Mon..Sun; keep it simple: if labels match common English, treat Wed == Wednesday etc.
  // If we’re in Hebrew/Creation, we compare positions (0..6) by a rough heuristic:
  const calOrder = {
    [CAL_GREG]: GREG_KEYS,
    [CAL_HEB]:  ["yom_sheni","yom_shelishi","yom_revi_i","yom_chamishi","yom_shishi","shabbat","yom_rishon"], // Mon..Sun positionally
    [CAL_CRE]:  ["day_two","day_three","day_four","day_five","day_six","sabbath","day_one"], // Mon..Sun positionally
  }[id.cal] || GREG_KEYS;

  const idx = calOrder.indexOf(id.key);
  return idx === todayGregIdx;
}

/* --------------------------------- UI bits --------------------------------- */
function FlavorPill({ label }) {
  if (!label) return null;
  return (
    <span className="chip chip--tiny" title={`Flavor: ${label}`}>
      {label}
    </span>
  );
}

/* ------------------------------- Main component ---------------------------- */
export default function PlanPretty({
  plan,
  calendar = CAL_GREG,          // for headings only; cards still work if mixed
  showTodayFlavorBadge = true,   // toggle “Today’s Flavor” badge
  className = "",
}) {
  // Normalize plan into an array of day entries: { day, label, meals, date? }
  const days = useMemo(() => {
    if (!plan) return [];
    if (Array.isArray(plan)) {
      return plan.map((d, i) => ({
        ...d,
        __idx: i,
        label: detectCalendarKey(d?.day || d?.name || d?.id || "").label,
      }));
    }
    return Object.keys(plan).map((k, i) => ({
      ...(plan[k] || {}),
      day: k,
      __idx: i,
      label: detectCalendarKey(k).label,
    }));
  }, [plan]);

  if (!days.length) {
    return (
      <div className={`card ${className}`}>
        <div className="subtitle">No plan found.</div>
      </div>
    );
  }

  return (
    <div className={className}>
      <div className="grid gap-3 md:gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
        {days.map((day) => {
          const dayFlavors = aggregateDayFlavors(day);
          const meals = Array.isArray(day?.meals) ? day.meals : [];
          const today = isTodayCard(day);

          return (
            <article key={day.__idx ?? day.label} className="card">
              {/* Header */}
              <header className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-base md:text-lg font-bold">{day.label}</div>
                  {day?.date ? (
                    <div className="text-xs text-[hsl(var(--muted-foreground))]">
                      {new Date(day.date).toLocaleDateString(undefined, { weekday: undefined, month: "short", day: "numeric" })}
                    </div>
                  ) : null}
                </div>

                {showTodayFlavorBadge && today && dayFlavors.length > 0 && (
                  <span
                    className="inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[10px] font-semibold"
                    style={{ borderColor: "hsl(var(--brand))", background: "hsl(var(--brand))/0.08" }}
                    aria-label="Today's Flavor"
                    title="Today's Flavor"
                  >
                    <span aria-hidden>⭐</span> Today’s Flavor
                  </span>
                )}
              </header>

              {/* Day-level aggregated flavors (compact row under header) */}
              {dayFlavors.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {dayFlavors.map((f) => (
                    <FlavorPill key={`dayFlavor-${day.__idx}-${f}`} label={f} />
                  ))}
                </div>
              )}

              {/* Meals list */}
              <div className="mt-3 space-y-2">
                {meals.length === 0 && (
                  <div className="text-sm text-[hsl(var(--muted-foreground))]">No meals yet.</div>
                )}
                {meals.map((m, i) => {
                  const title =
                    (typeof m === "string" ? m : m?.name || m?.title || "Meal").toString();
                  const fz = extractMealFlavors(m);

                  return (
                    <div key={i} className="rounded-lg border p-2 bg-white">
                      <div className="text-sm font-semibold">{title}</div>

                      {/* Tiny flavor pills per meal */}
                      {fz.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          {fz.map((tag) => (
                            <FlavorPill key={`mealFlavor-${day.__idx}-${i}-${tag}`} label={tag} />
                          ))}
                        </div>
                      )}

                      {/* Optional: quick notes */}
                      {Array.isArray(m?.notes) && m.notes.length > 0 && (
                        <ul className="mt-1 list-disc pl-4 text-xs text-[hsl(var(--muted-foreground))]">
                          {m.notes.slice(0, 2).map((n, ni) => (
                            <li key={ni}>{n}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  );
                })}
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

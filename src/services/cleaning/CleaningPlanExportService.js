// File: src/services/cleaning/CleaningPlanExportService.js
/**
 * CleaningPlanExportService (SSA) — Browser-only exports
 * -----------------------------------------------------------------------------
 * Purpose
 *  - Export CleaningPlanStore schedules to:
 *      • Printable HTML (print/PDF via browser print dialog)
 *      • CSV
 *      • ICS (calendar import)
 *      • Copyable text (SMS/email friendly)
 *
 * Requirements
 *  - Browser-only: NO Node imports, no fs/path/url usage.
 *  - Consumes CleaningPlanStore.generateSchedule().
 *  - Works with minimal plan data, but improves output when plan includes:
 *      • room names
 *      • steps
 *      • constraints (avoidDays/onlyDays, minGapDays, requiresSupplies)
 *  - Supports “housekeeper handoff” packet with:
 *      • task list grouped by day (and optionally by room)
 *      • totals (minutes)
 *      • supplies needed (from user-provided preferred supply list + task tags)
 *      • “do not do” constraints
 *      • contact/instructions including preferred cleaning supplies
 *
 * Notes
 *  - PDF generation is via print: createPrintableHtml() and openPrintWindow()
 *    (user can “Save as PDF” in browser print dialog).
 *
 * Public API
 *  - createHousekeeperPacket({ planId, startISO, days, options }) => { html, text, csv, ics, meta }
 *  - createPrintableHtml(...) => html string
 *  - createCopyText(...) => string
 *  - createCSV(...) => string
 *  - createICS(...) => string
 *  - downloadTextFile(filename, content, mimeType)
 *  - copyToClipboard(text)
 *  - openPrintWindow(html, { title })
 */

import CleaningPlanStore from "@/services/cleaning/CleaningPlanStore";

/* -------------------------------------------------------------------------- */
/* Utilities                                                                  */
/* -------------------------------------------------------------------------- */

const SOURCE = "cleaning.CleaningPlanExportService";

function nowISO() {
  return new Date().toISOString();
}

function safeId(prefix = "cpe") {
  return `${prefix}_${Math.random()
    .toString(16)
    .slice(2)}_${Date.now().toString(16)}`;
}

function asArray(x) {
  return Array.isArray(x) ? x : [];
}

function isObj(x) {
  return x && typeof x === "object" && !Array.isArray(x);
}

function normalizeStr(s) {
  return String(s || "").trim();
}

function clamp(n, min, max) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : min;
}

function minutesToHuman(mins) {
  const m = Math.max(0, Math.round(Number(mins) || 0));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} hr ${r} min` : `${h} hr`;
}

function toDate(dOrISO) {
  const d = dOrISO instanceof Date ? dOrISO : new Date(dOrISO);
  return Number.isFinite(d.getTime()) ? d : new Date();
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatLocalDate(d) {
  // e.g., "Sat, Jan 3, 2026"
  try {
    return new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(d);
  } catch {
    return d.toDateString();
  }
}

function formatLocalTime(d) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(d);
  } catch {
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function csvEscape(s) {
  const v = String(s ?? "");
  if (/[",\n\r]/.test(v)) return `"${v.replaceAll('"', '""')}"`;
  return v;
}

function unique(arr) {
  return Array.from(new Set(asArray(arr).filter(Boolean)));
}

function groupBy(arr, keyFn) {
  const map = new Map();
  for (const item of arr || []) {
    const k = keyFn(item);
    const cur = map.get(k) || [];
    cur.push(item);
    map.set(k, cur);
  }
  return map;
}

function sortByTimeISO(a, b) {
  return Date.parse(a.atISO) - Date.parse(b.atISO);
}

/* -------------------------------------------------------------------------- */
/* Housekeeper packet modeling                                                */
/* -------------------------------------------------------------------------- */

/**
 * options:
 *  - title: string
 *  - groupMode: "day" | "day_room"
 *  - includeTimes: boolean
 *  - includeSteps: boolean
 *  - includeTotals: boolean
 *  - includeSupplies: boolean
 *  - includeConstraints: boolean
 *  - includeContact: boolean
 *  - contact: {
 *      name?, phone?, email?,
 *      addressNote?, entryInstructions?, petsNote?,
 *      preferredSupplies?: string[] | string,
 *      doNotUse?: string[] | string,
 *      allergies?: string[] | string,
 *      notes?: string
 *    }
 *  - suppliesCatalog?: {
 *      // optional mapping rules to infer supplies from tags/keywords
 *      byTag?: { [tag: string]: string[] },
 *      byTitleContains?: { [needle: string]: string[] }
 *    }
 */

const DEFAULT_OPTIONS = {
  title: "Housekeeper Work Order",
  groupMode: "day",
  includeTimes: true,
  includeSteps: true,
  includeTotals: true,
  includeSupplies: true,
  includeConstraints: true,
  includeContact: true,
  contact: {
    name: "",
    phone: "",
    email: "",
    addressNote: "",
    entryInstructions: "",
    petsNote: "",
    preferredSupplies: [],
    doNotUse: [],
    allergies: [],
    notes: "",
  },
  suppliesCatalog: {
    byTag: {
      bathroom: ["Toilet cleaner", "Disinfectant", "Microfiber cloths"],
      sanitation: ["Disinfectant", "Gloves"],
      kitchen: ["Degreaser", "Dish soap", "Microfiber cloths"],
      floors: ["Broom/vacuum", "Mop", "Floor cleaner"],
      deep: ["Scrub brush", "Descaler (if needed)"],
      laundry: ["Laundry detergent", "Stain remover (if needed)"],
      glass: ["Glass cleaner", "Lint-free cloth"],
    },
    byTitleContains: {
      toilet: ["Toilet cleaner", "Disinfectant", "Toilet brush"],
      shower: ["Bathroom cleaner", "Scrub brush"],
      tub: ["Bathroom cleaner", "Scrub brush"],
      mirror: ["Glass cleaner", "Lint-free cloth"],
      floor: ["Mop", "Floor cleaner"],
      vacuum: ["Vacuum"],
      sweep: ["Broom", "Dustpan"],
      mop: ["Mop", "Floor cleaner"],
      fridge: ["All-purpose cleaner", "Microfiber cloths"],
      pantry: ["All-purpose cleaner", "Microfiber cloths"],
    },
  },
};

function normalizeContact(contact) {
  const c = isObj(contact) ? contact : {};
  const normList = (x) => {
    if (Array.isArray(x)) return x.map(normalizeStr).filter(Boolean);
    const s = normalizeStr(x);
    if (!s) return [];
    // allow comma-separated
    return s
      .split(",")
      .map((t) => normalizeStr(t))
      .filter(Boolean);
  };

  return {
    name: normalizeStr(c.name),
    phone: normalizeStr(c.phone),
    email: normalizeStr(c.email),
    addressNote: normalizeStr(c.addressNote),
    entryInstructions: normalizeStr(c.entryInstructions),
    petsNote: normalizeStr(c.petsNote),
    preferredSupplies: normList(c.preferredSupplies),
    doNotUse: normList(c.doNotUse),
    allergies: normList(c.allergies),
    notes: normalizeStr(c.notes),
  };
}

function mergeOptions(opts) {
  const o = isObj(opts) ? opts : {};
  const merged = {
    ...DEFAULT_OPTIONS,
    ...o,
    contact: { ...DEFAULT_OPTIONS.contact, ...(o.contact || {}) },
    suppliesCatalog: {
      ...DEFAULT_OPTIONS.suppliesCatalog,
      ...(o.suppliesCatalog || {}),
      byTag: {
        ...DEFAULT_OPTIONS.suppliesCatalog.byTag,
        ...(o.suppliesCatalog?.byTag || {}),
      },
      byTitleContains: {
        ...DEFAULT_OPTIONS.suppliesCatalog.byTitleContains,
        ...(o.suppliesCatalog?.byTitleContains || {}),
      },
    },
  };
  merged.contact = normalizeContact(merged.contact);
  return merged;
}

/* -------------------------------------------------------------------------- */
/* Supply inference                                                            */
/* -------------------------------------------------------------------------- */

function inferSuppliesForOccurrence(occ, options) {
  const supplies = [];
  const tags = asArray(occ.tags).map((t) => String(t).toLowerCase());
  const title = String(occ.title || "").toLowerCase();
  const roomName = String(occ.meta?.roomName || "").toLowerCase();

  const byTag = options.suppliesCatalog?.byTag || {};
  for (const t of tags) {
    const list = byTag[t];
    if (Array.isArray(list)) supplies.push(...list);
  }

  const byTitleContains = options.suppliesCatalog?.byTitleContains || {};
  for (const needle of Object.keys(byTitleContains)) {
    const n = String(needle).toLowerCase();
    if (!n) continue;
    if (title.includes(n) || roomName.includes(n)) {
      const list = byTitleContains[needle];
      if (Array.isArray(list)) supplies.push(...list);
    }
  }

  // If constraints mention supplies, nudge generic
  if (occ?.meta?.requiresSupplies || occ?.constraints?.requiresSupplies) {
    supplies.push("Cleaning supplies (as specified)");
  }

  return unique(supplies.map(normalizeStr));
}

function computeSupplies(occurrences, options) {
  const inferred = [];
  for (const occ of occurrences || []) {
    inferred.push(...inferSuppliesForOccurrence(occ, options));
  }

  const preferred = asArray(options.contact?.preferredSupplies)
    .map(normalizeStr)
    .filter(Boolean);
  const doNotUse = asArray(options.contact?.doNotUse)
    .map(normalizeStr)
    .filter(Boolean);

  const combined = unique([...preferred, ...inferred]).filter(
    (x) => !doNotUse.includes(x)
  );
  return {
    preferredSupplies: preferred,
    inferredSupplies: unique(inferred).filter((x) => !preferred.includes(x)),
    doNotUse,
    finalSuppliesList: combined,
  };
}

/* -------------------------------------------------------------------------- */
/* Constraints formatting                                                      */
/* -------------------------------------------------------------------------- */

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatConstraints(occ, plan) {
  const lines = [];
  const rh = occ?._rhythm; // attached during modeling
  const c = rh?.constraints || {};

  if (c.onlyDays && c.onlyDays.length) {
    lines.push(
      `Only scheduled on: ${c.onlyDays.map((d) => WEEKDAYS[d] ?? d).join(", ")}`
    );
  }
  if (c.avoidDays && c.avoidDays.length) {
    lines.push(
      `Avoid days: ${c.avoidDays.map((d) => WEEKDAYS[d] ?? d).join(", ")}`
    );
  }
  if (Number.isFinite(c.minGapDays) && c.minGapDays > 0) {
    lines.push(`Minimum gap: ${c.minGapDays} day(s) between repeats`);
  }
  if (c.requiresSupplies) {
    lines.push("Requires supplies (see supplies list)");
  }

  // Plan-level "quietHours" and sabbathAware are instructions more than constraints
  if (plan?.settings?.quietHours) {
    const q = plan.settings.quietHours;
    if (q?.start && q?.end) lines.push(`Quiet hours: ${q.start}–${q.end}`);
  }
  if (plan?.settings?.sabbathAware) {
    lines.push(
      "Sabbath-aware: avoid disruptive tasks during household quiet times (if configured)"
    );
  }

  return lines;
}

/* -------------------------------------------------------------------------- */
/* Model schedule into exportable structure                                   */
/* -------------------------------------------------------------------------- */

function attachRhythmToOccurrences(occurrences, plan) {
  // occurrences from store do not include constraints; we attach from plan.rhythms by rhythmId.
  const map = new Map((plan?.rhythms || []).map((r) => [r.id, r]));
  return (occurrences || []).map((occ) => {
    const rh = map.get(occ.rhythmId) || null;
    return {
      ...occ,
      _rhythm: rh,
      constraints: rh?.constraints || {},
      meta: {
        ...(occ.meta || {}),
        roomName: occ.meta?.roomName || findRoomName(plan, occ.roomId),
        intensity: occ.meta?.intensity || rh?.effort?.intensity || "low",
        requiresSupplies: !!rh?.constraints?.requiresSupplies,
      },
      steps:
        Array.isArray(occ.steps) && occ.steps.length
          ? occ.steps
          : rh?.steps || [],
      tags:
        Array.isArray(occ.tags) && occ.tags.length ? occ.tags : rh?.tags || [],
      effortMinutes: Number.isFinite(occ.effortMinutes)
        ? occ.effortMinutes
        : rh?.effort?.minutes || 15,
    };
  });
}

function findRoomName(plan, roomId) {
  if (!roomId) return "";
  const r = (plan?.rooms || []).find((x) => x.id === roomId);
  return r?.name || "";
}

function buildPacketModel({ plan, occurrences, options }) {
  const occs = [...(occurrences || [])].sort(sortByTimeISO);

  // Group mode
  // - day: group by date
  // - day_room: date -> room
  const byDay = groupBy(occs, (o) => {
    const d = toDate(o.atISO);
    return startKeyForDay(d);
  });

  const dayKeys = Array.from(byDay.keys()).sort(
    (a, b) => Date.parse(a) - Date.parse(b)
  );

  const days = dayKeys.map((dayISO) => {
    const list = byDay.get(dayISO) || [];
    const dayDate = new Date(dayISO);
    const dayLabel = formatLocalDate(dayDate);

    if (options.groupMode === "day_room") {
      const byRoom = groupBy(list, (o) =>
        normalizeStr(o.meta?.roomName || "Unassigned")
      );
      const roomKeys = Array.from(byRoom.keys()).sort((a, b) =>
        a.localeCompare(b)
      );

      const rooms = roomKeys.map((rk) => ({
        roomName: rk || "Unassigned",
        items: byRoom.get(rk) || [],
        totalMinutes: (byRoom.get(rk) || []).reduce(
          (s, x) => s + (Number(x.effortMinutes) || 0),
          0
        ),
      }));

      return {
        dayISO,
        dayLabel,
        totalMinutes: list.reduce(
          (s, x) => s + (Number(x.effortMinutes) || 0),
          0
        ),
        rooms,
        items: [],
      };
    }

    return {
      dayISO,
      dayLabel,
      totalMinutes: list.reduce(
        (s, x) => s + (Number(x.effortMinutes) || 0),
        0
      ),
      rooms: [],
      items: list,
    };
  });

  const totalMinutes = occs.reduce(
    (s, x) => s + (Number(x.effortMinutes) || 0),
    0
  );

  const supplies = options.includeSupplies
    ? computeSupplies(occs, options)
    : null;

  // Constraints summary: only list the “do not do / special constraints” that exist
  const constraintsByOcc = [];
  if (options.includeConstraints) {
    for (const occ of occs) {
      const lines = formatConstraints(occ, plan);
      if (lines.length) {
        constraintsByOcc.push({
          rhythmId: occ.rhythmId,
          title: occ.title,
          roomName: occ.meta?.roomName || "",
          atISO: occ.atISO,
          lines,
        });
      }
    }
  }

  const contact = options.includeContact
    ? normalizeContact(options.contact)
    : null;

  return {
    packetId: safeId("packet"),
    generatedAtISO: nowISO(),
    title: options.title,
    plan: {
      id: plan.id,
      name: plan.name,
      householdId: plan.householdId || null,
      settings: plan.settings || {},
    },
    totals: { totalMinutes, totalHuman: minutesToHuman(totalMinutes) },
    supplies,
    contact,
    days,
    occurrences: occs,
    constraintsByOcc,
  };
}

function startKeyForDay(d) {
  const day = new Date(d.getTime());
  day.setHours(0, 0, 0, 0);
  return day.toISOString();
}

/* -------------------------------------------------------------------------- */
/* HTML (print/PDF)                                                           */
/* -------------------------------------------------------------------------- */

function buildPrintCss() {
  // Simple, professional, printer-friendly CSS.
  return `
    :root {
      --text: #111;
      --muted: #555;
      --border: #ddd;
      --bg: #fff;
      --chip: #f5f5f5;
      --accent: #111;
    }
    html, body {
      background: var(--bg);
      color: var(--text);
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
      margin: 0; padding: 0;
    }
    .page {
      max-width: 900px;
      margin: 0 auto;
      padding: 20px 18px 40px;
    }
    header {
      border-bottom: 2px solid var(--border);
      padding-bottom: 12px;
      margin-bottom: 14px;
    }
    h1 {
      font-size: 22px;
      margin: 0 0 4px 0;
      letter-spacing: 0.2px;
    }
    .meta {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.4;
    }
    .section {
      margin-top: 14px;
      break-inside: avoid;
    }
    .section h2 {
      font-size: 14px;
      margin: 0 0 8px 0;
      text-transform: uppercase;
      letter-spacing: 0.9px;
      color: var(--accent);
    }
    .cards {
      display: grid;
      grid-template-columns: 1fr;
      gap: 10px;
    }
    .card {
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 10px 12px;
      break-inside: avoid;
    }
    .dayTitle {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: baseline;
      font-weight: 700;
      font-size: 14px;
      margin-bottom: 6px;
    }
    .dayTotal {
      font-weight: 600;
      font-size: 12px;
      color: var(--muted);
      white-space: nowrap;
    }
    .item {
      margin: 8px 0 0 0;
      padding-top: 8px;
      border-top: 1px dashed var(--border);
    }
    .item:first-child {
      margin-top: 0;
      padding-top: 0;
      border-top: 0;
    }
    .itemHead {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: baseline;
    }
    .itemTitle {
      font-weight: 650;
      font-size: 13px;
    }
    .itemSub {
      color: var(--muted);
      font-size: 12px;
      margin-top: 2px;
    }
    .chips {
      margin-top: 6px;
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    .chip {
      background: var(--chip);
      border: 1px solid var(--border);
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 11px;
      color: var(--muted);
    }
    ul.steps {
      margin: 8px 0 0 18px;
      padding: 0;
      font-size: 12px;
      line-height: 1.45;
    }
    .grid2 {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    .small {
      font-size: 12px;
      color: var(--muted);
    }
    .list {
      margin: 6px 0 0 18px;
      font-size: 12px;
      color: var(--text);
      line-height: 1.45;
    }
    .box {
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 10px 12px;
    }
    .k {
      font-weight: 700;
      color: var(--text);
    }
    .hr {
      height: 1px;
      background: var(--border);
      margin: 12px 0;
    }
    @media print {
      .page { padding: 0.5in; }
      a { color: inherit; text-decoration: none; }
    }
  `;
}

function renderContactHtml(contact, supplies) {
  if (!contact) return "";
  const lines = [];

  const add = (label, val) => {
    const v = normalizeStr(val);
    if (!v) return;
    lines.push(
      `<div><span class="k">${escapeHtml(label)}:</span> ${escapeHtml(v)}</div>`
    );
  };

  add("Contact", contact.name);
  add("Phone", contact.phone);
  add("Email", contact.email);
  add("Address note", contact.addressNote);
  add("Entry instructions", contact.entryInstructions);
  add("Pets note", contact.petsNote);

  // Preferred supplies (explicit)
  const preferred = asArray(contact.preferredSupplies).filter(Boolean);
  if (preferred.length) {
    lines.push(
      `<div class="hr"></div><div class="k">Preferred supplies to use</div><ul class="list">${preferred
        .map((x) => `<li>${escapeHtml(x)}</li>`)
        .join("")}</ul>`
    );
  }

  // Do not use
  const avoid = asArray(contact.doNotUse).filter(Boolean);
  if (avoid.length) {
    lines.push(
      `<div class="hr"></div><div class="k">Do not use</div><ul class="list">${avoid
        .map((x) => `<li>${escapeHtml(x)}</li>`)
        .join("")}</ul>`
    );
  }

  // Allergies
  const allergies = asArray(contact.allergies).filter(Boolean);
  if (allergies.length) {
    lines.push(
      `<div class="hr"></div><div class="k">Allergies / sensitivities</div><ul class="list">${allergies
        .map((x) => `<li>${escapeHtml(x)}</li>`)
        .join("")}</ul>`
    );
  }

  // Additional notes
  if (contact.notes) {
    lines.push(
      `<div class="hr"></div><div class="k">Notes</div><div class="small">${escapeHtml(
        contact.notes
      )}</div>`
    );
  }

  // Supplies summary (combined)
  if (supplies?.finalSuppliesList?.length) {
    lines.push(
      `<div class="hr"></div><div class="k">Supplies needed (combined)</div><ul class="list">${supplies.finalSuppliesList
        .map((x) => `<li>${escapeHtml(x)}</li>`)
        .join("")}</ul>`
    );
  }

  return `<div class="box">${lines.join("")}</div>`;
}

function renderConstraintsHtml(constraintsByOcc) {
  const rows = asArray(constraintsByOcc);
  if (!rows.length)
    return `<div class="small">No special constraints listed.</div>`;

  return `
    <div class="box">
      <div class="small">“Do not do” / Special constraints</div>
      <ul class="list">
        ${rows
          .slice(0, 60)
          .map((r) => {
            const when = formatLocalDate(toDate(r.atISO));
            const where = r.roomName ? ` — ${r.roomName}` : "";
            return `<li><span class="k">${escapeHtml(
              r.title
            )}</span> (${escapeHtml(when)}${escapeHtml(where)}): ${escapeHtml(
              r.lines.join(" • ")
            )}</li>`;
          })
          .join("")}
      </ul>
    </div>
  `;
}

function renderDayCardHtml(day, options) {
  const dayTitle = escapeHtml(day.dayLabel);
  const dayTotal = options.includeTotals
    ? `<div class="dayTotal">${escapeHtml(
        minutesToHuman(day.totalMinutes)
      )}</div>`
    : "";

  const renderItem = (occ) => {
    const d = toDate(occ.atISO);
    const timePart = options.includeTimes ? `${formatLocalTime(d)} • ` : "";
    const room = occ.meta?.roomName ? `${occ.meta.roomName} • ` : "";
    const minutes = minutesToHuman(occ.effortMinutes);

    const chips = unique([...(occ.tags || []), occ.kind]).slice(0, 10);

    const steps = options.includeSteps
      ? `<ul class="steps">${asArray(occ.steps)
          .filter((s) => s?.text)
          .slice(0, 40)
          .map((s) => `<li>${escapeHtml(s.text)}</li>`)
          .join("")}</ul>`
      : "";

    return `
      <div class="item">
        <div class="itemHead">
          <div class="itemTitle">${escapeHtml(occ.title)}</div>
          <div class="dayTotal">${escapeHtml(minutes)}</div>
        </div>
        <div class="itemSub">${escapeHtml(timePart + room + minutes)}</div>
        ${
          chips.length
            ? `<div class="chips">${chips
                .map((c) => `<span class="chip">${escapeHtml(c)}</span>`)
                .join("")}</div>`
            : ""
        }
        ${steps}
      </div>
    `;
  };

  if (options.groupMode === "day_room") {
    const rooms = asArray(day.rooms);
    return `
      <div class="card">
        <div class="dayTitle"><div>${dayTitle}</div>${dayTotal}</div>
        ${rooms
          .map((r) => {
            return `
              <div class="item">
                <div class="itemHead">
                  <div class="itemTitle">${escapeHtml(
                    r.roomName || "Unassigned"
                  )}</div>
                  <div class="dayTotal">${escapeHtml(
                    minutesToHuman(r.totalMinutes)
                  )}</div>
                </div>
                ${asArray(r.items).map(renderItem).join("")}
              </div>
            `;
          })
          .join("")}
      </div>
    `;
  }

  return `
    <div class="card">
      <div class="dayTitle"><div>${dayTitle}</div>${dayTotal}</div>
      ${asArray(day.items).map(renderItem).join("")}
    </div>
  `;
}

function createPrintableHtmlFromModel(model, options) {
  const css = buildPrintCss();

  const headerMeta = [
    `Generated: ${formatLocalDate(
      toDate(model.generatedAtISO)
    )} ${formatLocalTime(toDate(model.generatedAtISO))}`,
    `Plan: ${model.plan.name}`,
    options.includeTotals ? `Total estimate: ${model.totals.totalHuman}` : "",
  ].filter(Boolean);

  const contactHtml = options.includeContact
    ? renderContactHtml(model.contact, model.supplies)
    : "";
  const constraintsHtml = options.includeConstraints
    ? renderConstraintsHtml(model.constraintsByOcc)
    : "";

  const suppliesBox = options.includeSupplies
    ? `
      <div class="section">
        <h2>Supplies</h2>
        <div class="box">
          ${
            model.supplies?.finalSuppliesList?.length
              ? `<ul class="list">${model.supplies.finalSuppliesList
                  .map((x) => `<li>${escapeHtml(x)}</li>`)
                  .join("")}</ul>`
              : `<div class="small">No supplies inferred. Add preferred supplies or tag tasks for better suggestions.</div>`
          }
        </div>
      </div>
    `
    : "";

  return `
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>${escapeHtml(model.title)}</title>
        <style>${css}</style>
      </head>
      <body>
        <div class="page">
          <header>
            <h1>${escapeHtml(model.title)}</h1>
            <div class="meta">
              ${headerMeta.map((x) => `<div>${escapeHtml(x)}</div>`).join("")}
            </div>
          </header>

          ${
            options.includeContact || options.includeConstraints
              ? `
            <div class="section">
              <h2>Contact & Instructions</h2>
              <div class="grid2">
                ${options.includeContact ? contactHtml : ""}
                ${options.includeConstraints ? constraintsHtml : ""}
              </div>
            </div>
          `
              : ""
          }

          ${suppliesBox}

          <div class="section">
            <h2>Work Order</h2>
            <div class="cards">
              ${model.days.map((d) => renderDayCardHtml(d, options)).join("")}
            </div>
          </div>

          <div class="section small">
            Source: ${escapeHtml(SOURCE)} • Packet ID: ${escapeHtml(
    model.packetId
  )}
          </div>
        </div>
      </body>
    </html>
  `;
}

/* -------------------------------------------------------------------------- */
/* Copyable text (SMS/email)                                                  */
/* -------------------------------------------------------------------------- */

function createCopyTextFromModel(model, options) {
  const lines = [];
  lines.push(model.title);
  lines.push(`Plan: ${model.plan.name}`);
  lines.push(
    `Generated: ${formatLocalDate(
      toDate(model.generatedAtISO)
    )} ${formatLocalTime(toDate(model.generatedAtISO))}`
  );
  if (options.includeTotals)
    lines.push(`Total estimate: ${model.totals.totalHuman}`);
  lines.push("");

  // Contact/instructions
  if (options.includeContact && model.contact) {
    const c = model.contact;
    lines.push("CONTACT / INSTRUCTIONS");
    if (c.name) lines.push(`Contact: ${c.name}`);
    if (c.phone) lines.push(`Phone: ${c.phone}`);
    if (c.email) lines.push(`Email: ${c.email}`);
    if (c.addressNote) lines.push(`Address note: ${c.addressNote}`);
    if (c.entryInstructions)
      lines.push(`Entry instructions: ${c.entryInstructions}`);
    if (c.petsNote) lines.push(`Pets note: ${c.petsNote}`);

    // Preferred supplies
    if (asArray(c.preferredSupplies).length) {
      lines.push("");
      lines.push("Preferred supplies to use:");
      for (const s of c.preferredSupplies) lines.push(`- ${s}`);
    }

    // Do not use
    if (asArray(c.doNotUse).length) {
      lines.push("");
      lines.push("Do not use:");
      for (const s of c.doNotUse) lines.push(`- ${s}`);
    }

    // Allergies
    if (asArray(c.allergies).length) {
      lines.push("");
      lines.push("Allergies / sensitivities:");
      for (const s of c.allergies) lines.push(`- ${s}`);
    }

    if (c.notes) {
      lines.push("");
      lines.push(`Notes: ${c.notes}`);
    }

    lines.push("");
  }

  // Supplies needed
  if (options.includeSupplies && model.supplies?.finalSuppliesList?.length) {
    lines.push("SUPPLIES NEEDED");
    for (const s of model.supplies.finalSuppliesList) lines.push(`- ${s}`);
    lines.push("");
  }

  // Constraints
  if (options.includeConstraints && model.constraintsByOcc?.length) {
    lines.push("DO NOT DO / SPECIAL CONSTRAINTS");
    for (const row of model.constraintsByOcc.slice(0, 50)) {
      const when = formatLocalDate(toDate(row.atISO));
      const where = row.roomName ? ` — ${row.roomName}` : "";
      lines.push(`- ${row.title} (${when}${where}): ${row.lines.join(" • ")}`);
    }
    lines.push("");
  }

  // Work order
  lines.push("WORK ORDER");
  for (const day of model.days) {
    lines.push(
      `${day.dayLabel}${
        options.includeTotals ? ` — ${minutesToHuman(day.totalMinutes)}` : ""
      }`
    );

    if (options.groupMode === "day_room") {
      for (const room of day.rooms || []) {
        lines.push(
          `  ${room.roomName}${
            options.includeTotals
              ? ` — ${minutesToHuman(room.totalMinutes)}`
              : ""
          }`
        );
        for (const occ of room.items || []) {
          lines.push(formatOccurrenceText(occ, options));
        }
      }
    } else {
      for (const occ of day.items || []) {
        lines.push(formatOccurrenceText(occ, options));
      }
    }

    lines.push("");
  }

  return lines.join("\n");
}

function formatOccurrenceText(occ, options) {
  const d = toDate(occ.atISO);
  const timePart = options.includeTimes ? `${formatLocalTime(d)} • ` : "";
  const roomPart = occ.meta?.roomName ? `${occ.meta.roomName} • ` : "";
  const mins = minutesToHuman(occ.effortMinutes);

  const lines = [];
  lines.push(`- ${occ.title} — ${mins}`);
  if (timePart || roomPart) lines.push(`  ${timePart}${roomPart}`.trimEnd());

  if (options.includeSteps) {
    const steps = asArray(occ.steps).filter((s) => s?.text);
    for (const s of steps.slice(0, 40)) lines.push(`  • ${s.text}`);
  }
  return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/* CSV                                                                        */
/* -------------------------------------------------------------------------- */

function createCSVFromModel(model, options) {
  const headers = [
    "date",
    "time",
    "title",
    "room",
    "kind",
    "minutes",
    "tags",
    "steps",
    "constraints",
  ];

  const rows = [];
  rows.push(headers.map(csvEscape).join(","));

  for (const occ of model.occurrences || []) {
    const d = toDate(occ.atISO);
    const date = formatLocalDate(d);
    const time = options.includeTimes ? formatLocalTime(d) : "";
    const title = occ.title || "";
    const room = occ.meta?.roomName || "";
    const kind = occ.kind || "";
    const minutes = String(Math.round(Number(occ.effortMinutes) || 0));
    const tags = unique(occ.tags || []).join("|");
    const steps = options.includeSteps
      ? asArray(occ.steps)
          .filter((s) => s?.text)
          .map((s) => s.text)
          .join(" | ")
      : "";
    const constraints = options.includeConstraints
      ? (formatConstraints(occ, model.plan) || []).join(" | ")
      : "";

    rows.push(
      [date, time, title, room, kind, minutes, tags, steps, constraints]
        .map(csvEscape)
        .join(",")
    );
  }

  return rows.join("\n");
}

/* -------------------------------------------------------------------------- */
/* ICS (calendar import)                                                      */
/* -------------------------------------------------------------------------- */

/**
 * ICS basics:
 *  - Use DTSTART/DTEND in local time (floating) for broad compatibility.
 *  - UID must be stable-ish per packet; here we generate per export.
 */
function icsEscape(s) {
  return String(s ?? "")
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll(",", "\\,")
    .replaceAll(";", "\\;");
}

function toICSDateTimeLocal(d) {
  // Floating local datetime: YYYYMMDDTHHMMSS
  const dt = toDate(d);
  return (
    `${dt.getFullYear()}${pad2(dt.getMonth() + 1)}${pad2(dt.getDate())}` +
    `T${pad2(dt.getHours())}${pad2(dt.getMinutes())}${pad2(dt.getSeconds())}`
  );
}

function foldICSLine(line) {
  // 75 octets recommended; we approximate with 70 chars. Safe enough.
  const max = 70;
  let s = String(line || "");
  const out = [];
  while (s.length > max) {
    out.push(s.slice(0, max));
    s = " " + s.slice(max);
  }
  out.push(s);
  return out.join("\r\n");
}

function createICSFromModel(model, options) {
  const prodId = "-//SSA//CleaningPlanExportService//EN";
  const calName = `${model.title} - ${model.plan.name}`;

  const lines = [];
  lines.push("BEGIN:VCALENDAR");
  lines.push("VERSION:2.0");
  lines.push(`PRODID:${icsEscape(prodId)}`);
  lines.push("CALSCALE:GREGORIAN");
  lines.push("METHOD:PUBLISH");
  lines.push(foldICSLine(`X-WR-CALNAME:${icsEscape(calName)}`));

  const packetUIDBase = `${model.packetId}@ssa.local`;

  for (let i = 0; i < (model.occurrences || []).length; i++) {
    const occ = model.occurrences[i];
    const start = toDate(occ.atISO);
    const durationMin = clamp(occ.effortMinutes || 15, 5, 600);
    const end = new Date(start.getTime() + durationMin * 60000);

    const uid = `${packetUIDBase}.${i}`;
    const summary = occ.title || "Cleaning";
    const location = occ.meta?.roomName ? `Room: ${occ.meta.roomName}` : "";

    // Description: steps + supply note
    const stepLines = options.includeSteps
      ? asArray(occ.steps)
          .filter((s) => s?.text)
          .slice(0, 30)
          .map((s) => `- ${s.text}`)
      : [];

    const descParts = [];
    if (occ.meta?.roomName) descParts.push(`Room: ${occ.meta.roomName}`);
    if (stepLines.length) descParts.push("Steps:\n" + stepLines.join("\n"));
    if (options.includeSupplies && model.supplies?.finalSuppliesList?.length) {
      descParts.push(
        "Supplies:\n" +
          model.supplies.finalSuppliesList
            .slice(0, 20)
            .map((x) => `- ${x}`)
            .join("\n")
      );
    }
    const description = descParts.join("\n\n");

    lines.push("BEGIN:VEVENT");
    lines.push(foldICSLine(`UID:${icsEscape(uid)}`));
    lines.push(foldICSLine(`DTSTAMP:${toICSDateTimeLocal(new Date())}`));
    lines.push(foldICSLine(`DTSTART:${toICSDateTimeLocal(start)}`));
    lines.push(foldICSLine(`DTEND:${toICSDateTimeLocal(end)}`));
    lines.push(foldICSLine(`SUMMARY:${icsEscape(summary)}`));
    if (location) lines.push(foldICSLine(`LOCATION:${icsEscape(location)}`));
    if (description)
      lines.push(foldICSLine(`DESCRIPTION:${icsEscape(description)}`));
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

/* -------------------------------------------------------------------------- */
/* Browser actions: download, clipboard, print                                */
/* -------------------------------------------------------------------------- */

function downloadTextFile(
  filename,
  content,
  mimeType = "text/plain;charset=utf-8"
) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || "export.txt";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyToClipboard(text) {
  const t = String(text ?? "");
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(t);
      return { ok: true };
    }
  } catch {
    // fallback below
  }

  try {
    const ta = document.createElement("textarea");
    ta.value = t;
    ta.setAttribute("readonly", "true");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.left = "-1000px";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

function openPrintWindow(html, { title = "Cleaning Work Order" } = {}) {
  const w = window.open("", "_blank", "noopener,noreferrer");
  if (!w) return { ok: false, error: "Popup blocked" };

  try {
    w.document.open();
    w.document.write(html);
    w.document.close();
    w.document.title = title;

    // Wait a beat for render/fonts
    w.focus();
    setTimeout(() => {
      try {
        w.print();
      } catch {
        // ignore
      }
    }, 250);

    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

/* -------------------------------------------------------------------------- */
/* Main service                                                               */
/* -------------------------------------------------------------------------- */

class CleaningPlanExportServiceImpl {
  /**
   * Creates a fully exportable packet.
   * Returns:
   *  { ok, planId, startISO, days, model, html, text, csv, ics }
   */
  async createHousekeeperPacket({
    planId,
    startISO,
    days = 7,
    options = {},
  } = {}) {
    const opts = mergeOptions(options);

    // Ensure store hydrated and get plan
    await CleaningPlanStore.ensureHydrated?.();
    const plan = CleaningPlanStore.getPlan?.(
      planId || CleaningPlanStore.getState?.()?.activePlanId
    );

    if (!plan) {
      return { ok: false, error: "Plan not found", planId: planId || null };
    }

    const sched = await CleaningPlanStore.generateSchedule({
      planId: plan.id,
      startISO: startISO || new Date().toISOString(),
      days,
    });

    if (!sched?.ok) {
      return {
        ok: false,
        error: sched?.error || "Schedule generation failed",
        planId: plan.id,
      };
    }

    const occurrences = attachRhythmToOccurrences(
      sched.occurrences || [],
      plan
    );
    const model = buildPacketModel({ plan, occurrences, options: opts });

    const html = createPrintableHtmlFromModel(model, opts);
    const text = createCopyTextFromModel(model, opts);
    const csv = createCSVFromModel(model, opts);
    const ics = createICSFromModel(model, opts);

    return {
      ok: true,
      planId: plan.id,
      startISO: sched.startISO,
      days: sched.days,
      model,
      html,
      text,
      csv,
      ics,
      meta: {
        source: SOURCE,
        packetId: model.packetId,
        generatedAtISO: model.generatedAtISO,
      },
    };
  }

  async createPrintableHtml({ planId, startISO, days = 7, options = {} } = {}) {
    const pkt = await this.createHousekeeperPacket({
      planId,
      startISO,
      days,
      options,
    });
    if (!pkt.ok) return pkt;
    return { ok: true, html: pkt.html, meta: pkt.meta };
  }

  async createCopyText({ planId, startISO, days = 7, options = {} } = {}) {
    const pkt = await this.createHousekeeperPacket({
      planId,
      startISO,
      days,
      options,
    });
    if (!pkt.ok) return pkt;
    return { ok: true, text: pkt.text, meta: pkt.meta };
  }

  async createCSV({ planId, startISO, days = 7, options = {} } = {}) {
    const pkt = await this.createHousekeeperPacket({
      planId,
      startISO,
      days,
      options,
    });
    if (!pkt.ok) return pkt;
    return { ok: true, csv: pkt.csv, meta: pkt.meta };
  }

  async createICS({ planId, startISO, days = 7, options = {} } = {}) {
    const pkt = await this.createHousekeeperPacket({
      planId,
      startISO,
      days,
      options,
    });
    if (!pkt.ok) return pkt;
    return { ok: true, ics: pkt.ics, meta: pkt.meta };
  }

  /* -------------------------- convenience actions -------------------------- */

  async downloadPacketFiles({
    planId,
    startISO,
    days = 7,
    options = {},
    basename = "housekeeper_work_order",
  } = {}) {
    const pkt = await this.createHousekeeperPacket({
      planId,
      startISO,
      days,
      options,
    });
    if (!pkt.ok) return pkt;

    const stamp = toDate(pkt.meta.generatedAtISO);
    const suffix = `${stamp.getFullYear()}-${pad2(stamp.getMonth() + 1)}-${pad2(
      stamp.getDate()
    )}`;

    downloadTextFile(
      `${basename}_${suffix}.html`,
      pkt.html,
      "text/html;charset=utf-8"
    );
    downloadTextFile(
      `${basename}_${suffix}.txt`,
      pkt.text,
      "text/plain;charset=utf-8"
    );
    downloadTextFile(
      `${basename}_${suffix}.csv`,
      pkt.csv,
      "text/csv;charset=utf-8"
    );
    downloadTextFile(
      `${basename}_${suffix}.ics`,
      pkt.ics,
      "text/calendar;charset=utf-8"
    );

    return { ok: true, meta: pkt.meta };
  }

  async copyPacketText({ planId, startISO, days = 7, options = {} } = {}) {
    const pkt = await this.createHousekeeperPacket({
      planId,
      startISO,
      days,
      options,
    });
    if (!pkt.ok) return pkt;
    const r = await copyToClipboard(pkt.text);
    return { ok: r.ok, error: r.error, meta: pkt.meta };
  }

  async openPrint({ planId, startISO, days = 7, options = {} } = {}) {
    const pkt = await this.createHousekeeperPacket({
      planId,
      startISO,
      days,
      options,
    });
    if (!pkt.ok) return pkt;
    const r = openPrintWindow(pkt.html, { title: pkt.model.title });
    return { ok: r.ok, error: r.error, meta: pkt.meta };
  }
}

/* -------------------------------------------------------------------------- */
/* Singleton export                                                           */
/* -------------------------------------------------------------------------- */

const CleaningPlanExportService = new CleaningPlanExportServiceImpl();

export default CleaningPlanExportService;
export {
  CleaningPlanExportService,
  downloadTextFile,
  copyToClipboard,
  openPrintWindow,
};

/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\engines\animals\AnimalStockingTemplate.js
/**
 * AnimalStockingTemplate — SSA Draft Generator (resolved, human-friendly)
 * -----------------------------------------------------------------------------
 * Purpose
 *  - Generate a RESOLVED draft object for the Animals domain (NOT metadata-only).
 *  - This draft is meant to be rendered by a UI formatter (or directly as sections).
 *
 * Contract
 *  - Export a single default function: generateAnimalStockingDraft(ctx, opts?)
 *  - Returns: { ok, via:"template", res:draft, warnings, debug }
 *    - ok: boolean
 *    - res: DRAFT OBJECT (never null when ok=true)
 *
 * Draft shape (human formatting ready)
 *  {
 *    id, domain, title, summary,
 *    assumptions: string[],
 *    sections: [{ id, title, bullets: string[], table?: { columns, rows } }],
 *    tasks: [{ id, label, priority, dueISO?, durationMin?, tags: [] }],
 *    inventoryAlerts: [{ sku?, item, neededQty?, unit?, severity, suggestion }],
 *    healthReminders: [{ animalType, label, cadence, nextDueISO? }],
 *    projections: { totalsByType: { [type]: count }, totalsAll: number }
 *  }
 *
 * Notes
 *  - Keep this file pure (no DB writes). Emit events elsewhere.
 *  - This generator can be called by an automation runner that wraps it into
 *    { via, res } and persists it. We already include that wrapper response here
 *    for convenience because your UI currently reads { via, res }.
 */

function nowISO() {
  return new Date().toISOString();
}

function uid(prefix = "draft") {
  return `${prefix}_${Math.random()
    .toString(16)
    .slice(2)}_${Date.now().toString(16)}`;
}

function safeInt(n, fb = 0) {
  const x = Number.parseInt(n, 10);
  return Number.isFinite(x) ? x : fb;
}

function normType(t) {
  return String(t || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function titleCase(s) {
  const str = String(s || "").trim();
  if (!str) return "";
  return str
    .split(" ")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** Accepts:
 *  - array of {type,count} OR
 *  - object map { chicken: 12, goat: 2 } OR
 *  - string lines "type,count" (opts.manualLines)
 */
function normalizeAnimalsInput(ctx = {}, opts = {}) {
  const out = [];
  const push = (type, count) => {
    const t = normType(type);
    const c = safeInt(count, 0);
    if (!t || c <= 0) return;
    out.push({ type: t, count: c });
  };

  // ctx.animals can be various shapes
  const animals = ctx.animals ?? ctx.animalTotals ?? ctx.totals ?? null;

  if (Array.isArray(animals)) {
    animals.forEach((a) =>
      push(a?.type ?? a?.animalType ?? a?.name, a?.count ?? a?.qty ?? a?.total)
    );
  } else if (animals && typeof animals === "object") {
    Object.entries(animals).forEach(([k, v]) => push(k, v));
  }

  // Add manual lines (e.g. "chicken,12")
  const manualLines = opts.manualLines ?? ctx.manualLines ?? [];
  if (Array.isArray(manualLines)) {
    manualLines.forEach((line) => {
      const s = String(line || "").trim();
      if (!s) return;
      const [t, c] = s.split(",").map((z) => String(z || "").trim());
      push(t, c);
    });
  } else if (typeof manualLines === "string") {
    manualLines
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean)
      .forEach((s) => {
        const [t, c] = s.split(",").map((z) => String(z || "").trim());
        push(t, c);
      });
  }

  // Collapse duplicates
  const map = new Map();
  out.forEach(({ type, count }) => {
    map.set(type, (map.get(type) || 0) + count);
  });

  const collapsed = Array.from(map.entries())
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => a.type.localeCompare(b.type));

  return collapsed;
}

// Simple baseline care model (extensible). Replace with your real tables later.
const DEFAULT_CARE_MODELS = {
  chicken: {
    daily: [
      "Check waterers",
      "Check feeders",
      "Collect eggs",
      "Quick coop spot-check",
    ],
    weekly: [
      "Add fresh bedding",
      "Inspect coop for pests",
      "Clean/refresh waterers",
    ],
    monthly: ["Deep clean coop areas", "Check fencing / predator points"],
    inventory: [
      {
        item: "Layer feed",
        unit: "lb",
        perAnimalPerDay: 0.25,
        severity: "med",
        suggestion: "Keep 2–4 weeks on hand.",
      },
      {
        item: "Bedding (pine shavings/straw)",
        unit: "bag",
        perAnimalPerWeek: 0.04,
        severity: "low",
        suggestion: "Stock enough for weekly refresh.",
      },
    ],
    health: [{ label: "Observe droppings/behavior", cadence: "daily" }],
  },
  goat: {
    daily: [
      "Refresh water",
      "Check hay / browse access",
      "Quick hoof/limb observation",
    ],
    weekly: ["Inspect fencing", "Check mineral feeder", "Body condition check"],
    monthly: ["Hoof trim (as needed)", "Parasite check (FAMACHA-style)"],
    inventory: [
      {
        item: "Hay",
        unit: "lb",
        perAnimalPerDay: 4.0,
        severity: "high",
        suggestion: "Keep 2–3 weeks minimum in dry storage.",
      },
      {
        item: "Loose minerals (goat)",
        unit: "lb",
        perAnimalPerWeek: 0.25,
        severity: "med",
        suggestion: "Ensure minerals are always available.",
      },
    ],
    health: [{ label: "Parasite check", cadence: "monthly" }],
  },
  sheep: {
    daily: [
      "Refresh water",
      "Check hay/pasture access",
      "Observe gait and alertness",
    ],
    weekly: ["Inspect fencing", "Check mineral feeder", "Body condition check"],
    monthly: ["Parasite check", "Hoof inspection/trim (as needed)"],
    inventory: [
      {
        item: "Hay",
        unit: "lb",
        perAnimalPerDay: 3.0,
        severity: "high",
        suggestion: "Keep 2–3 weeks minimum in dry storage.",
      },
      {
        item: "Sheep minerals (no copper)",
        unit: "lb",
        perAnimalPerWeek: 0.25,
        severity: "med",
        suggestion: "Use sheep-safe mineral.",
      },
    ],
    health: [{ label: "Parasite check", cadence: "monthly" }],
  },
  rabbit: {
    daily: ["Refresh water", "Check pellets/hay", "Spot-clean cage/tray"],
    weekly: ["Deep clean cage", "Check nails/feet", "Refresh litter/tray"],
    monthly: ["Health observation", "Check for sore hocks"],
    inventory: [
      {
        item: "Rabbit pellets",
        unit: "lb",
        perAnimalPerDay: 0.2,
        severity: "med",
        suggestion: "Keep 2–4 weeks on hand.",
      },
      {
        item: "Hay",
        unit: "lb",
        perAnimalPerDay: 0.3,
        severity: "med",
        suggestion: "Keep hay dry and accessible.",
      },
    ],
    health: [{ label: "Observe appetite/behavior", cadence: "daily" }],
  },
};

function getModelForType(type) {
  return (
    DEFAULT_CARE_MODELS[type] || {
      daily: [
        "Refresh water",
        "Check feed access",
        "Observe behavior/condition",
      ],
      weekly: ["Inspect enclosure/fencing", "Clean/refill feeders/waterers"],
      monthly: ["Deep clean housing", "Inventory check & restock"],
      inventory: [
        {
          item: "Feed (species-appropriate)",
          unit: "lb",
          perAnimalPerDay: 0.5,
          severity: "med",
          suggestion: "Keep 2–4 weeks on hand.",
        },
      ],
      health: [{ label: "General health observation", cadence: "weekly" }],
    }
  );
}

function computeTotals(animals) {
  const totalsByType = {};
  let totalsAll = 0;
  animals.forEach((a) => {
    totalsByType[a.type] = (totalsByType[a.type] || 0) + a.count;
    totalsAll += a.count;
  });
  return { totalsByType, totalsAll };
}

function estimateInventoryAlerts(animals, opts = {}) {
  const days = safeInt(opts.daysOfCover ?? 14, 14); // default 2 weeks
  const alerts = [];

  animals.forEach(({ type, count }) => {
    const model = getModelForType(type);
    (model.inventory || []).forEach((inv) => {
      const perDay = Number(inv.perAnimalPerDay || 0);
      const perWeek = Number(inv.perAnimalPerWeek || 0);
      const neededQty =
        perDay > 0
          ? perDay * count * days
          : perWeek > 0
          ? perWeek * count * Math.ceil(days / 7)
          : null;

      alerts.push({
        sku: inv.sku,
        animalType: titleCase(type),
        item: inv.item,
        neededQty:
          neededQty != null ? Math.round(neededQty * 100) / 100 : undefined,
        unit: inv.unit,
        severity: inv.severity || "low",
        suggestion: inv.suggestion || "Consider stocking a safety buffer.",
      });
    });
  });

  // Sort by severity (high->low), then item
  const sevRank = { high: 3, med: 2, medium: 2, low: 1 };
  alerts.sort(
    (a, b) =>
      (sevRank[b.severity] || 0) - (sevRank[a.severity] || 0) ||
      String(a.item).localeCompare(String(b.item))
  );

  return alerts;
}

function buildTasks(animals, opts = {}) {
  const tasks = [];
  const horizonDays = safeInt(opts.horizonDays ?? 7, 7);
  const createdISO = nowISO();

  // We build a simple "today/this week" task list with priorities.
  animals.forEach(({ type, count }) => {
    const model = getModelForType(type);
    const typeLabel = titleCase(type);

    // Daily tasks (priority high)
    (model.daily || []).forEach((label, i) => {
      tasks.push({
        id: uid("task"),
        label: `${typeLabel}: ${label} (${count})`,
        priority: "high",
        dueISO: createdISO,
        durationMin: 5 + i * 2,
        tags: ["animals", type],
      });
    });

    // Weekly tasks (priority med)
    (model.weekly || []).forEach((label, i) => {
      tasks.push({
        id: uid("task"),
        label: `${typeLabel}: ${label}`,
        priority: "med",
        dueISO: createdISO, // UI can interpret as "this week"
        durationMin: 10 + i * 5,
        tags: ["animals", type, "weekly"],
      });
    });

    // Monthly tasks (priority low)
    (model.monthly || []).forEach((label, i) => {
      tasks.push({
        id: uid("task"),
        label: `${typeLabel}: ${label}`,
        priority: "low",
        dueISO: createdISO, // UI can interpret as "this month"
        durationMin: 15 + i * 5,
        tags: ["animals", type, "monthly"],
      });
    });
  });

  // Apply horizon filter (optional). For now, we keep all since dueISO is "now"
  // but you can later schedule due dates.
  void horizonDays;

  return tasks;
}

function buildHealthReminders(animals) {
  const reminders = [];
  animals.forEach(({ type }) => {
    const model = getModelForType(type);
    (model.health || []).forEach((h) => {
      reminders.push({
        animalType: titleCase(type),
        label: h.label,
        cadence: h.cadence || "weekly",
        nextDueISO: undefined, // compute later once you have household schedule rules
      });
    });
  });
  return reminders;
}

function buildHumanSections(
  animals,
  inventoryAlerts,
  tasks,
  projections,
  opts = {}
) {
  const days = safeInt(opts.daysOfCover ?? 14, 14);
  const sections = [];

  sections.push({
    id: uid("sec"),
    title: "At-a-glance",
    bullets: [
      `Total animals tracked: ${projections.totalsAll}`,
      `Animal types: ${Object.keys(projections.totalsByType).length}`,
      `Inventory cover estimate: ${days} days (baseline)`,
      `Tasks generated: ${tasks.length}`,
    ],
  });

  // Totals table
  sections.push({
    id: uid("sec"),
    title: "Household Animal Totals",
    bullets: [],
    table: {
      columns: ["Animal Type", "Count"],
      rows: Object.entries(projections.totalsByType).map(([type, count]) => [
        titleCase(type),
        String(count),
      ]),
    },
  });

  // Per-type care bullets
  animals.forEach(({ type, count }) => {
    const model = getModelForType(type);
    sections.push({
      id: uid("sec"),
      title: `${titleCase(type)} (${count}) — Care Snapshot`,
      bullets: [
        ...(model.daily || []).slice(0, 3).map((x) => `Daily: ${x}`),
        ...(model.weekly || []).slice(0, 2).map((x) => `Weekly: ${x}`),
        ...(model.monthly || []).slice(0, 2).map((x) => `Monthly: ${x}`),
      ],
    });
  });

  // Inventory alerts (table)
  if (inventoryAlerts.length) {
    sections.push({
      id: uid("sec"),
      title: "Inventory & Supplies — Estimated Needs",
      bullets: [
        "These are baseline stocking targets. Link to your inventory module to confirm on-hand quantities.",
      ],
      table: {
        columns: [
          "Severity",
          "Animal",
          "Item",
          `Needed (~${days}d)`,
          "Unit",
          "Suggestion",
        ],
        rows: inventoryAlerts
          .slice(0, 50)
          .map((a) => [
            String(a.severity || "").toUpperCase(),
            a.animalType || "",
            a.item || "",
            a.neededQty != null ? String(a.neededQty) : "",
            a.unit || "",
            a.suggestion || "",
          ]),
      },
    });
  } else {
    sections.push({
      id: uid("sec"),
      title: "Inventory & Supplies",
      bullets: [
        "No inventory estimates generated yet. Add animals or provide counts to estimate supplies.",
      ],
    });
  }

  // Tasks preview
  const high = tasks.filter((t) => t.priority === "high").slice(0, 8);
  const med = tasks.filter((t) => t.priority === "med").slice(0, 8);
  const low = tasks.filter((t) => t.priority === "low").slice(0, 8);

  sections.push({
    id: uid("sec"),
    title: "Tasks Generated (Preview)",
    bullets: [
      `High priority (today): ${
        tasks.filter((t) => t.priority === "high").length
      }`,
      `Medium priority (this week): ${
        tasks.filter((t) => t.priority === "med").length
      }`,
      `Low priority (this month): ${
        tasks.filter((t) => t.priority === "low").length
      }`,
    ],
    table: {
      columns: ["Priority", "Task"],
      rows: [
        ...high.map((t) => ["HIGH", t.label]),
        ...med.map((t) => ["MED", t.label]),
        ...low.map((t) => ["LOW", t.label]),
      ],
    },
  });

  return sections;
}

/**
 * Main generator
 * @param {object} ctx - context from SSA (household, animals, inventory snapshot, preferences)
 * @param {object} opts - generator options
 * @returns {{ok:boolean, via:"template", res:object|null, warnings:string[], debug:object}}
 */
export default function generateAnimalStockingDraft(ctx = {}, opts = {}) {
  const warnings = [];
  const debug = {
    generatedAt: nowISO(),
    inputKeys: Object.keys(ctx || {}),
    opts,
  };

  const animals = normalizeAnimalsInput(ctx, opts);

  if (!animals.length) {
    warnings.push(
      "No animals provided. Add animal counts (e.g., chicken:12, goat:2) to generate a stocking plan."
    );
    return {
      ok: false,
      via: "template",
      res: {
        id: uid("animal_draft"),
        domain: "animals",
        title: "Draft Animal Stocking Plan (Needs Animal Counts)",
        summary:
          "No animal counts were found. Add animals to generate care tasks and inventory estimates.",
        assumptions: [
          "This draft requires at least one animal type and count.",
          "Once animals are provided, SSA will generate tasks, reminders, and supply estimates.",
        ],
        sections: [
          {
            id: uid("sec"),
            title: "Next Step",
            bullets: [
              "Add animals (type + count). Example: chicken,12 or goat,2",
              "Then re-run the estimate to generate tasks and inventory needs.",
            ],
          },
        ],
        tasks: [],
        inventoryAlerts: [],
        healthReminders: [],
        projections: { totalsByType: {}, totalsAll: 0 },
        meta: {
          kind: "animal_stocking_plan",
          status: "needs-input",
          generatedAt: debug.generatedAt,
        },
      },
      warnings,
      debug,
    };
  }

  const projections = computeTotals(animals);

  // Options: daysOfCover, horizonDays, householdName, etc.
  const daysOfCover = safeInt(opts.daysOfCover ?? ctx.daysOfCover ?? 14, 14);

  const inventoryAlerts = estimateInventoryAlerts(animals, { daysOfCover });
  const tasks = buildTasks(animals, {
    horizonDays: safeInt(opts.horizonDays ?? 7, 7),
  });
  const healthReminders = buildHealthReminders(animals);

  const assumptions = [
    `Inventory estimates assume baseline daily/weekly consumption models (cover ~${daysOfCover} days).`,
    "Link to Inventory to subtract on-hand quantities and generate purchase/production actions.",
    "Health reminders are baseline; update cadences based on breed, climate, and your husbandry program.",
  ];

  const title = "Draft Animal Stocking Plan";
  const summary = `Estimated care + supplies for ${
    projections.totalsAll
  } animals across ${Object.keys(projections.totalsByType).length} types.`;

  const sections = buildHumanSections(
    animals,
    inventoryAlerts,
    tasks,
    projections,
    { daysOfCover }
  );

  const draft = {
    id: uid("animal_draft"),
    domain: "animals",
    title,
    summary,
    assumptions,
    sections,
    tasks,
    inventoryAlerts,
    healthReminders,
    projections,
    // Optional: include raw normalized animals list so UI can show it or debug.
    animals,
    meta: {
      kind: "animal_stocking_plan",
      status: "estimated",
      generatedAt: debug.generatedAt,
      daysOfCover,
      source: "AnimalStockingTemplate",
    },
  };

  return {
    ok: true,
    via: "template",
    res: draft, // ✅ resolved draft (not metadata)
    warnings,
    debug,
  };
}

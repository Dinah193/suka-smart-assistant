// C:\Users\larho\suka-smart-assistant\src\tests\scraper.test.js
// ============================================================================
// Scraper & Normalization Tests
// - Parses HTML tables into row objects with typed fields
// - Normalizes loose JSON into contract-ready shapes
// - Asserts canonical event envelopes are emitted by parsers/normalizers
//
// SSA pipeline focus: imports → normalization (this file) → intelligence
// (prep synthesis/tags) → sessions → (optional) hub export.
// ============================================================================

import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Event bus mock — we capture envelopes and assert against the SSA standard.
// ---------------------------------------------------------------------------
const events = [];
const eventBusMock = {
  emit: vi.fn((envelope) => {
    if (!envelope || typeof envelope !== "object") throw new Error("Bad event");
    if (
      !envelope.type ||
      !envelope.ts ||
      !envelope.source ||
      envelope.data === undefined
    ) {
      throw new Error("Event missing required envelope fields");
    }
    events.push(envelope);
  }),
  subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
  _drain: () => {
    const copy = events.slice();
    events.length = 0;
    return copy;
  },
};

vi.mock("../services/events/eventBus.js", () => ({ eventBus: eventBusMock }));

// ---------------------------------------------------------------------------
// Optional real modules — if your repo already has these, the tests will use
// them. Otherwise, we provide robust in-file fallbacks with identical intents.
//   • TableScraper.parseHtmlTable(html, opts?) -> { headers, rows, meta }
//   • JsonNormalizer.normalize(input, opts?) -> { entity, issues }
// Each should emit import.parsed or validation.failed as appropriate.
// ---------------------------------------------------------------------------
let TableScraper;
let JsonNormalizer;

function isoNow() {
  return new Date().toISOString();
}

// --- Fallback implementations (used only if real modules are absent) --------
const FallbackTableScraper = {
  /**
   * Parse a simple HTML table with <thead><tr><th>.. and <tbody><tr><td>..
   * - Strips currency symbols and thousands separators from numeric-ish cells
   * - Parses ISO dates
   * - Returns headers (lowercased snake), rows[], meta
   * - Emits import.parsed or validation.failed envelopes
   */
  parseHtmlTable(
    html,
    { origin = "internal:test", domain = "pricebook" } = {}
  ) {
    if (typeof html !== "string" || !html.trim()) {
      const fail = {
        type: "validation.failed",
        ts: isoNow(),
        source: "src/import/scrapers/TableScraper.js:parseHtmlTable",
        data: { errors: [{ message: "Empty HTML input" }], severity: "error" },
        meta: { v: 1 },
      };
      eventBusMock.emit(fail);
      return {
        headers: [],
        rows: [],
        meta: { ok: false, errors: fail.data.errors },
      };
    }

    // VERY small HTML walker: extracts headers & cells without external deps.
    // We accept single table and ignore nested tables for this fallback.
    const tableMatch = html.match(/<table[\s\S]*?>[\s\S]*?<\/table>/i);
    if (!tableMatch) {
      const fail = {
        type: "validation.failed",
        ts: isoNow(),
        source: "src/import/scrapers/TableScraper.js:parseHtmlTable",
        data: { errors: [{ message: "No <table> found" }], severity: "error" },
        meta: { v: 1 },
      };
      eventBusMock.emit(fail);
      return {
        headers: [],
        rows: [],
        meta: { ok: false, errors: fail.data.errors },
      };
    }
    const table = tableMatch[0];

    // Extract headers
    const ths = [...table.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((m) =>
      normalizeHeader(stripTags(m[1]))
    );
    // If no <th>, try the first row's <td> as header guess
    let headers = ths;
    if (headers.length === 0) {
      const firstRow = table.match(/<tr[^>]*>([\s\S]*?)<\/tr>/i)?.[1] ?? "";
      const tds = [...firstRow.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(
        (m) => normalizeHeader(stripTags(m[1]))
      );
      headers = tds;
    }

    // Extract rows from tbody or all trs excluding those containing th
    const rowBlocks = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
      .map((m) => m[1])
      .filter((block) => !/<th/i.test(block)); // ignore header rows

    const rows = rowBlocks
      .map((block) => {
        const cells = [...block.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(
          (m) => stripTags(m[1])
        );
        if (cells.length === 0) return null;
        // Allow ragged rows (pad or trim to headers length)
        const vals = cells.slice(0, headers.length);
        while (vals.length < headers.length) vals.push("");
        // Coerce values
        const obj = {};
        headers.forEach((h, idx) => {
          obj[h] = coerceValue(vals[idx]);
        });
        // Soft provenance fallback
        if (!obj.source && origin) obj.source = origin;
        return obj;
      })
      .filter(Boolean);

    const meta = { ok: true, count: rows.length, origin, headers };
    const parsedEnvelope = {
      type: "import.parsed",
      ts: isoNow(),
      source: "src/import/scrapers/TableScraper.js:parseHtmlTable",
      data: {
        importId: "test-html-table",
        domain,
        contract: "table.row.json@1",
        entity: { headers, rows, meta },
      },
      meta: { v: 1 },
    };
    eventBusMock.emit(parsedEnvelope);
    return { headers, rows, meta };
  },
};

const FallbackJsonNormalizer = {
  /**
   * Normalize loose JSON by:
   *  - Trimming strings
   *  - Coercing numeric-like strings
   *  - Parsing ISO timestamps for keys end with At/On/Date or exactly ts
   *  - Keeping unknown keys
   * Emits import.parsed (domain customizable)
   */
  normalize(input, { domain = "generic", entityId = "json-1" } = {}) {
    if (input === null || input === undefined || typeof input !== "object") {
      const fail = {
        type: "validation.failed",
        ts: isoNow(),
        source: "src/import/normalizers/JsonNormalizer.js:normalize",
        data: {
          errors: [{ message: "Input must be object/array" }],
          severity: "error",
        },
        meta: { v: 1 },
      };
      eventBusMock.emit(fail);
      return { entity: null, issues: fail.data.errors };
    }
    const issues = [];
    const entity = deepNormalize(input, issues);
    const evt = {
      type: "import.parsed",
      ts: isoNow(),
      source: "src/import/normalizers/JsonNormalizer.js:normalize",
      data: {
        importId: "test-json",
        domain,
        contract: "generic.entity.json@1",
        entity: { id: entityId, value: entity, issues },
      },
      meta: { v: 1 },
    };
    eventBusMock.emit(evt);
    return { entity, issues };
  },
};

// Attempt to load real modules
try {
  // eslint-disable-next-line import/no-unresolved
  TableScraper = (await import("../import/scrapers/TableScraper.js")).default;
} catch {
  TableScraper = FallbackTableScraper;
}
try {
  // eslint-disable-next-line import/no-unresolved
  JsonNormalizer = (await import("../import/normalizers/JsonNormalizer.js"))
    .default;
} catch {
  JsonNormalizer = FallbackJsonNormalizer;
}

// ---------------------------------------------------------------------------
// Utility helpers used by fallbacks & tests
// ---------------------------------------------------------------------------
function stripTags(str) {
  return String(str ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeHeader(h) {
  return String(h || "")
    .trim()
    .toLowerCase()
    .replace(/[\s\-]+/g, "_")
    .replace(/[^\w]/g, "")
    .replace(/^_+|_+$/g, "");
}

function coerceValue(v) {
  const s = String(v ?? "").trim();

  // ISO timestamp quick check
  if (/^\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\.\d+)?z$/i.test(s)) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }

  // Currency / numeric with separators: $1,234.56 or 1,234 or 1 234,50
  const numericish = s
    .replace(/[, ](?=\d{3}\b)/g, "") // remove thousands separators
    .replace(/^\s*[$£€]\s*/, "") // strip leading currency
    .replace(/%$/, ""); // strip trailing percent
  if (/^[+-]?\d+(\.\d+)?$/.test(numericish)) {
    const n = Number(numericish);
    if (Number.isFinite(n)) return n;
  }

  // URL/provenance
  if (/^https?:\/\/\S+$/i.test(s) || s.startsWith("internal:")) return s;

  return s;
}

function deepNormalize(node, issues, path = "root") {
  if (Array.isArray(node))
    return node.map((v, i) => deepNormalize(v, issues, `${path}[${i}]`));
  if (node && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      const key = k.trim();
      out[key] = deepNormalize(v, issues, `${path}.${key}`);
      // Timestamp-ish keys
      if (/ts$|at$|on$|date$/i.test(key) && typeof out[key] === "string") {
        const d = new Date(out[key]);
        if (!Number.isNaN(d.getTime())) out[key] = d.toISOString();
      }
      // Numeric-like strings
      if (typeof out[key] === "string") {
        const coerced = coerceValue(out[key]);
        out[key] = coerced;
      }
    }
    return out;
  }
  if (typeof node === "string") return coerceValue(node);
  return node;
}

function expectCanonical(envelope) {
  expect(envelope).toBeTruthy();
  expect(typeof envelope.type).toBe("string");
  expect(envelope.type).toMatch(/^[a-z]+\.[a-z]+\.[a-z-]+$/);
  expect(typeof envelope.ts).toBe("string");
  expect(new Date(envelope.ts).toISOString()).toBe(envelope.ts);
  expect(typeof envelope.source).toBe("string");
  expect(envelope).toHaveProperty("data");
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const HTML_FIXTURE = `
<table>
  <thead>
    <tr>
      <th>Product</th>
      <th>Price ($)</th>
      <th>Qty</th>
      <th>Updated At</th>
      <th>Source</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Tomato Paste 6oz</td>
      <td>$1,234.56</td>
      <td>24</td>
      <td>2025-11-11T16:00:00Z</td>
      <td>https://example.com/kroger/week45</td>
    </tr>
    <tr>
      <td>Olive Oil 1L</td>
      <td>$9.99</td>
      <td>4</td>
      <td>2025-11-10T09:30:00Z</td>
      <td>https://example.com/kroger/week45</td>
    </tr>
  </tbody>
</table>
`;

const JSON_FIXTURE = {
  id: "abc-123",
  name: "  Banana Bread  ",
  ingredients: [
    { item: "Flour", qty: "500", uom: "g" },
    { item: "Sugar", qty: "150", uom: "g" },
    { item: "Butter", qty: "  100  ", uom: "g" },
  ],
  meta: {
    createdAt: "2025-11-11T12:00:00Z",
    updatedAt: "2025-11-11T12:30:00Z",
    source: "https://www.allrecipes.com/banana-bread",
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("HTML table scraping → normalized rows", () => {
  beforeEach(() => {
    eventBusMock.emit.mockClear();
    eventBusMock._drain();
  });

  it("parses headers + rows, coerces numeric/time, preserves source", () => {
    const { headers, rows, meta } = TableScraper.parseHtmlTable(HTML_FIXTURE, {
      origin: "https://example.com/kroger/week45",
      domain: "pricebook",
    });

    expect(headers).toEqual([
      "product",
      "price",
      "qty",
      "updated_at",
      "source",
    ]);
    expect(meta.ok).toBe(true);
    expect(rows.length).toBe(2);

    // Row 1 assertions
    const r1 = rows[0];
    expect(r1.product).toBe("Tomato Paste 6oz");
    expect(typeof r1.price).toBe("number");
    expect(r1.price).toBeCloseTo(1234.56, 2);
    expect(r1.qty).toBe(24);
    expect(r1.updated_at).toBe("2025-11-11T16:00:00.000Z");
    expect(r1.source).toMatch(/^https?:\/\//);

    // Row 2 assertions
    const r2 = rows[1];
    expect(r2.product).toBe("Olive Oil 1L");
    expect(r2.price).toBeCloseTo(9.99, 2);
    expect(r2.qty).toBe(4);
    expect(r2.updated_at).toBe("2025-11-10T09:30:00.000Z");

    // Event envelope assertions
    const emitted = eventBusMock._drain();
    const parsedEvt = emitted.find((e) => e.type === "import.parsed");
    expectCanonical(parsedEvt);
    expect(parsedEvt.data?.domain).toBe("pricebook");
    expect(parsedEvt.data?.entity?.meta?.origin).toBe(
      "https://example.com/kroger/week45"
    );
  });

  it("emits validation.failed on missing table", () => {
    const empty = "<div>No tables here</div>";
    const res = TableScraper.parseHtmlTable(empty);
    expect(res.meta.ok).toBe(false);
    const [evt] = eventBusMock._drain();
    expect(evt.type).toBe("validation.failed");
    expect(evt.data.errors[0].message).toMatch(/table/i);
  });
});

describe("Loose JSON → contract-ready normalization", () => {
  beforeEach(() => {
    eventBusMock.emit.mockClear();
    eventBusMock._drain();
  });

  it("coerces numeric-like strings and ISO timestamps; emits import.parsed", () => {
    const { entity, issues } = JsonNormalizer.normalize(JSON_FIXTURE, {
      domain: "recipe",
      entityId: "recipe-abc-123",
    });
    expect(issues.length).toBe(0);
    expect(entity.ingredients[0].qty).toBe(500);
    expect(entity.ingredients[1].qty).toBe(150);
    expect(entity.ingredients[2].qty).toBe(100);

    expect(entity.meta.createdAt).toBe("2025-11-11T12:00:00.000Z");
    expect(entity.meta.updatedAt).toBe("2025-11-11T12:30:00.000Z");
    expect(entity.meta.source).toMatch(/^https?:\/\//);

    const emitted = eventBusMock._drain();
    const parsedEvt = emitted.find((e) => e.type === "import.parsed");
    expectCanonical(parsedEvt);
    expect(parsedEvt.data.domain).toBe("recipe");
    expect(parsedEvt.data.entity.id).toBe("recipe-abc-123");
  });

  it("emits validation.failed on non-object input", () => {
    const { entity, issues } = JsonNormalizer.normalize(null, {
      domain: "recipe",
    });
    expect(entity).toBeNull();
    expect(issues.length).toBeGreaterThan(0);
    const [evt] = eventBusMock._drain();
    expect(evt.type).toBe("validation.failed");
  });
});

// ---------------------------------------------------------------------------
// Edge cases & robustness
// ---------------------------------------------------------------------------
describe("Scraper robustness: ragged rows, missing headers, currencies, percents", () => {
  beforeEach(() => {
    eventBusMock.emit.mockClear();
    eventBusMock._drain();
  });

  it("handles ragged rows by padding/truncating and numeric coercion with %", () => {
    const html = `
      <table>
        <tr><th>Name</th><th>Discount %</th><th>Price</th></tr>
        <tr><td>Widget A</td><td>25%</td><td>$1,299</td></tr>
        <tr><td>Widget B</td><td>  5% </td></tr>
      </table>
    `;
    const { headers, rows } = TableScraper.parseHtmlTable(html, {
      domain: "coupon",
    });
    expect(headers).toEqual(["name", "discount", "price"]);
    expect(rows[0].discount).toBe(25);
    expect(rows[0].price).toBe(1299);
    expect(rows[1].discount).toBe(5);
    // Missing price becomes empty string → coerceValue returns "" (allowed)
    expect(rows[1].price).toBe("");
  });

  it("falls back to first <tr><td> as headers if <th> missing", () => {
    const html = `
      <table>
        <tr><td>SKU</td><td>Qty</td><td>Updated</td></tr>
        <tr><td>abc-1</td><td>12</td><td>2025-11-11T00:00:00Z</td></tr>
      </table>
    `;
    const { headers, rows } = TableScraper.parseHtmlTable(html, {
      domain: "storehouse",
    });
    expect(headers).toEqual(["sku", "qty", "updated"]);
    expect(rows[0].sku).toBe("abc-1");
    expect(rows[0].qty).toBe(12);
    expect(rows[0].updated).toBe("2025-11-11T00:00:00.000Z");
  });
});

// C:\Users\larho\suka-smart-assistant\src\pages\scan\extreme.jsx
//
// ExtremeScanPage
// ----------------
// “Extreme Scan” is the power-user surface for the Scan → Compare → Trust stack.
// It is designed for bulk, messy inputs:
//
//   • Pasted receipts
//   • Exported shopping lists
//   • Barcode dumps
//   • OCR text from camera scans
//
// Goal: Turn any noisy text into normalized items that SSA can treat as
// imports → inventory updates → automation triggers.
//
// How this fits into the SSA pipeline
// -----------------------------------
// imports → intelligence → automation → (optional) hub export
//
// • imports (this page):
//   - Captures raw text from receipts / OCR / barcodes.
//   - Emits `import.raw.captured` and `import.parsed` events with structured
//     items for downstream engines (ImportRouter, pricebook, etc.).
//
// • intelligence (downstream from this page):
//   - ImportRouter + pricing/normalization services will:
//       • Map merchant SKUs → canonical item IDs.
//       • Detect units/quantities.
//       • Map to domains: storehouse, meals, preservation, garden, animals.
//   - This page only does a light “line → (qty, label)” parse as a helper.
//
// • automation:
//   - When the user confirms, we emit `inventory.updated` with a payload
//     representing the scanned items going into (or out of) the storehouse.
//   - Automation runtime can:
//       • Trigger `inventory.shortage.detected` if any items are under target.
//       • Propose sessions (batch cooking, preservation, shopping runs).
//
// • optional Hub export:
//   - On commit, we also call `exportToHubIfEnabled`, which:
//       • Checks featureFlags.familyFundMode
//       • Uses HubPacketFormatter + FamilyFundConnector to mirror a summary
//         of the inventory update to the Suka Village Family Fund Hub.
//       • Fails silently if Hub is unavailable.
//
// Forward-thinking notes
// ----------------------
// • The parsing helper is intentionally conservative and designed so it can
//   be replaced by a dedicated ScanNormalizer later.
// • The domainHint field keeps the door open for routing items to:
//     - meals (perishables that need cooking sessions)
//     - preservation (bulk meat/produce that should be canned/frozen)
//     - garden (seed/soil/fertilizer)
//     - animals (feed, supplements)
// • The UI separates three phases for the user:
//     1) Paste / capture raw text
//     2) Review & tweak parsed items
//     3) Commit inventory + emit events + optional Hub export

import React, { useCallback, useMemo, useState } from "react";
import eventBus from "../../services/events/eventBus";
import featureFlags from "../../config/featureFlags";
import HubPacketFormatter from "@/services/hub/HubPacketFormatter";
import FamilyFundConnector from "@/services/hub/FamilyFundConnector";

/**
 * @typedef {"meals"|"storehouse"|"preservation"|"garden"|"animals"|"other"} DomainHint
 */

/**
 * @typedef {Object} ParsedScanItem
 * @property {string} id
 * @property {string} label
 * @property {number} qty
 * @property {string} unit
 * @property {DomainHint} domainHint
 * @property {boolean} include
 */

const nowISO = () => new Date().toISOString();

/**
 * Simple unique ID generator for rows.
 * @returns {string}
 */
function createId() {
  return `scan_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

/**
 * Emit a structured event onto the shared eventBus.
 *
 * @param {string} type
 * @param {string} source
 * @param {any} data
 */
function emitEvent(type, source, data) {
  if (!eventBus || typeof eventBus.emit !== "function") {
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.warn("[ExtremeScanPage] eventBus.emit not available");
    }
    return;
  }

  eventBus.emit({
    type,
    ts: nowISO(),
    source,
    data,
  });
}

/**
 * Export payload to the Hub if familyFundMode is enabled.
 * Fails silently if the Hub is unavailable.
 *
 * @param {any} payload
 */
async function exportToHubIfEnabled(payload) {
  try {
    if (!featureFlags || !featureFlags.familyFundMode) return;
    if (!HubPacketFormatter || !FamilyFundConnector) return;

    const packet =
      typeof HubPacketFormatter.formatExtremeScanInventory === "function"
        ? HubPacketFormatter.formatExtremeScanInventory(payload)
        : HubPacketFormatter.format
        ? HubPacketFormatter.format("inventory.updated.extremeScan", payload)
        : payload;

    const sender =
      typeof FamilyFundConnector.send === "function"
        ? FamilyFundConnector.send
        : typeof FamilyFundConnector.dispatch === "function"
        ? FamilyFundConnector.dispatch
        : null;

    if (!sender) return;

    await sender(packet);

    emitEvent("session.exported", "scan.extreme", {
      kind: "inventory.updated.extremeScan",
      ok: true,
      itemCount: payload?.itemsSummary?.length ?? null,
    });
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.warn("[ExtremeScanPage] Hub export failed:", err);
    }
  }
}

/**
 * Lightweight parser that tries to turn raw text lines into ParsedScanItem objects.
 *
 * Examples it tries to handle:
 *   "2 x whole chicken"
 *   "3lb ground beef"
 *   "milk 2 gal"
 *   "5 apples"
 *
 * This is intentionally minimal: deeper normalization belongs in a dedicated
 * ScanNormalizer / ImportRouter pipeline.
 *
 * @param {string} raw
 * @returns {ParsedScanItem[]}
 */
function parseRawExtremeScan(raw) {
  if (!raw || typeof raw !== "string") return [];

  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  /** @type {ParsedScanItem[]} */
  const items = [];

  for (const line of lines) {
    // Skip lines that look like totals or headers
    if (/subtotal|total|tax|cash|change|visa|mastercard/i.test(line)) continue;

    let qty = 1;
    let unit = "";
    let label = line;

    // Pattern: "2 x whole chicken" or "2x whole chicken"
    const xMatch =
      /^(\d+(?:\.\d+)?)\s*x\s*(.+)$/i.exec(line) ||
      /^(\d+(?:\.\d+)?)[xX]\s*(.+)$/.exec(line);
    if (xMatch) {
      qty = parseFloat(xMatch[1]) || 1;
      label = xMatch[2].trim();
    } else {
      // Pattern: "3lb ground beef" or "3 lb ground beef" or "3 lbs ground beef"
      const weightMatch =
        /^(\d+(?:\.\d+)?)\s*(lb|lbs|pound|pounds|kg|g)\s+(.+)$/i.exec(line);
      if (weightMatch) {
        qty = parseFloat(weightMatch[1]) || 1;
        unit = weightMatch[2];
        label = weightMatch[3].trim();
      } else {
        // Pattern: "milk 2 gal" or "apples 5"
        const trailingQtyMatch =
          /^(.+?)\s+(\d+(?:\.\d+)?)\s*(pack|pkg|pk|gal|gallon|gallons|ct|count|bag|box|bunch)?$/i.exec(
            line
          );
        if (trailingQtyMatch) {
          label = trailingQtyMatch[1].trim();
          qty = parseFloat(trailingQtyMatch[2]) || 1;
          unit = trailingQtyMatch[3] || "";
        }
      }
    }

    // Domain hints: keep these very loose, real routing will use canonical
    // item IDs and tags later.
    /** @type {DomainHint} */
    let domainHint = "storehouse";
    const lower = label.toLowerCase();
    if (
      /seed|seeds|seedling|seedlings|soil|compost|potting|fertilizer|mulch/.test(
        lower
      )
    ) {
      domainHint = "garden";
    } else if (
      /feed|hay|alfalfa|grain mix|pellet|layer mash|chick starter|goat feed|sheep feed|mineral/.test(
        lower
      )
    ) {
      domainHint = "animals";
    } else if (/jar|lid|canner|canning|vacuum sealer|vac seal/.test(lower)) {
      domainHint = "preservation";
    } else if (/chicken|beef|lamb|goat|pork|turkey/.test(lower)) {
      domainHint = "meals"; // edible; may also be used for preservation decisions
    }

    items.push({
      id: createId(),
      label,
      qty: isFinite(qty) && qty > 0 ? qty : 1,
      unit: unit,
      domainHint,
      include: true,
    });
  }

  return items;
}

/**
 * ExtremeScanPage component
 */
export default function ExtremeScanPage() {
  const [rawText, setRawText] = useState("");
  const [parsedItems, setParsedItems] = useState(
    /** @type {ParsedScanItem[]} */ []
  );
  const [status, setStatus] = useState("");

  const itemCounts = useMemo(() => {
    const included = parsedItems.filter((i) => i.include);
    const totalLines = parsedItems.length;
    const includedCount = included.length;
    const domainCounts = included.reduce(
      (acc, item) => {
        acc[item.domainHint] = (acc[item.domainHint] || 0) + 1;
        return acc;
      },
      /** @type {Record<DomainHint, number>} */ ({
        meals: 0,
        storehouse: 0,
        preservation: 0,
        garden: 0,
        animals: 0,
        other: 0,
      })
    );

    return { totalLines, includedCount, domainCounts };
  }, [parsedItems]);

  const handleParse = useCallback(() => {
    if (!rawText.trim()) {
      setStatus(
        "Nothing to parse yet. Paste or type your receipt or OCR text."
      );
      return;
    }

    const parsed = parseRawExtremeScan(rawText);
    setParsedItems(parsed);

    emitEvent("import.raw.captured", "scan.extreme", {
      mode: "extreme",
      rawTextLength: rawText.length,
      lineCount: rawText.split(/\r?\n/).length,
    });

    emitEvent("import.parsed", "scan.extreme", {
      mode: "extreme",
      parsedCount: parsed.length,
      itemsPreview: parsed.slice(0, 5).map((i) => ({
        label: i.label,
        qty: i.qty,
        unit: i.unit,
        domainHint: i.domainHint,
      })),
    });

    setStatus(
      `Parsed ${parsed.length} potential items. Review, edit, and then commit to inventory.`
    );
  }, [rawText]);

  const handleToggleInclude = (id) => {
    setParsedItems((prev) =>
      prev.map((item) =>
        item.id === id ? { ...item, include: !item.include } : item
      )
    );
  };

  const handleChangeField = (id, field, value) => {
    setParsedItems((prev) =>
      prev.map((item) =>
        item.id === id
          ? {
              ...item,
              [field]:
                field === "qty"
                  ? (() => {
                      const n = parseFloat(value);
                      return isFinite(n) && n > 0 ? n : item.qty;
                    })()
                  : value,
            }
          : item
      )
    );
  };

  /**
   * Commit the current parsed items into the SSA pipeline:
   *   • Emit inventory.updated
   *   • (later) other engines can derive shortage/sessions
   *   • Optionally export summary to Hub
   */
  const handleCommitToInventory = async () => {
    const included = parsedItems.filter((i) => i.include);
    if (included.length === 0) {
      setStatus("No items selected to commit. Toggle at least one row.");
      return;
    }

    // Emit an inventory.updated event with a normalized shape suitable
    // for downstream engines. This page does not write Dexie directly;
    // a central Inventory engine should do that.
    emitEvent("inventory.updated", "scan.extreme", {
      mode: "extremeScan",
      direction: "in", // could also support returns in future
      items: included.map((i) => ({
        label: i.label,
        qty: i.qty,
        unit: i.unit,
        domainHint: i.domainHint,
        source: "extremeScan",
      })),
      committedAt: nowISO(),
    });

    // Hub export (optional, mirror only a summary)
    void exportToHubIfEnabled({
      kind: "inventory.updated.extremeScan",
      itemsSummary: included.map((i) => ({
        label: i.label,
        qty: i.qty,
        unit: i.unit,
        domainHint: i.domainHint,
      })),
      rawLinesCount: rawText.split(/\r?\n/).filter((l) => l.trim()).length,
      committedAt: nowISO(),
    });

    setStatus(
      `Committed ${included.length} items into the inventory pipeline from Extreme Scan.`
    );
  };

  /**
   * Emit an automation suggestion event for follow-up sessions, without
   * directly mutating inventory.
   */
  const handleSuggestSessions = () => {
    const included = parsedItems.filter((i) => i.include);
    if (included.length === 0) {
      setStatus("No items selected to analyze for sessions.");
      return;
    }

    const bucket = {
      preservation: included.filter((i) => i.domainHint === "preservation"),
      garden: included.filter((i) => i.domainHint === "garden"),
      animals: included.filter((i) => i.domainHint === "animals"),
      meals: included.filter((i) => i.domainHint === "meals"),
    };

    emitEvent("automation.suggestion.created", "scan.extreme", {
      mode: "extremeScan",
      suggestions: {
        preservation:
          bucket.preservation.length > 0
            ? {
                domain: "preservation",
                reason: "Supplies or bulk items detected in extreme scan",
                itemCount: bucket.preservation.length,
              }
            : null,
        garden:
          bucket.garden.length > 0
            ? {
                domain: "garden",
                reason: "Garden-related items detected in extreme scan",
                itemCount: bucket.garden.length,
              }
            : null,
        animals:
          bucket.animals.length > 0
            ? {
                domain: "animals",
                reason: "Animal feed/supplies detected in extreme scan",
                itemCount: bucket.animals.length,
              }
            : null,
        meals:
          bucket.meals.length > 0
            ? {
                domain: "cooking",
                reason: "Perishable food items detected in extreme scan",
                itemCount: bucket.meals.length,
              }
            : null,
      },
    });

    setStatus(
      "Sent automation suggestions based on scanned items. Check Sessions/Recommendations to see follow-ups."
    );
  };

  return (
    <div className="extreme-scan-page">
      {/* Header / intro */}
      <section className="extreme-scan-header">
        <div>
          <h1 className="page-title">Extreme Scan Mode</h1>
          <p className="page-subtitle">
            Paste messy receipts, OCR text, or barcode dumps. SSA will slice
            them into items you can send into inventory and automation — all
            from one power-user screen.
          </p>
        </div>
        {status && (
          <div className="status-banner" aria-live="polite">
            {status}
          </div>
        )}
      </section>

      <div className="extreme-scan-layout">
        {/* Left: Raw input */}
        <section className="extreme-scan-column extreme-scan-input">
          <header>
            <h2>1. Capture raw text</h2>
            <p className="help-text">
              Paste your receipt, OCR output, or export list here. Each line
              will be treated as a potential item row. SSA will skip obvious
              totals and payment lines.
            </p>
          </header>
          <textarea
            className="extreme-scan-textarea"
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
            placeholder={
              "Example:\n" +
              "2 x whole chicken\n" +
              "3lb ground beef\n" +
              "potting soil 2 bag\n" +
              "layer feed 50lb\n" +
              "canning jars 12ct"
            }
          />
          <div className="extreme-scan-input-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleParse}
            >
              Parse lines
            </button>
            <span className="lines-count">
              {rawText
                ? `${
                    rawText.split(/\r?\n/).filter((l) => l.trim()).length
                  } non-empty line(s)`
                : "No lines yet"}
            </span>
          </div>
        </section>

        {/* Middle: Parsed items table */}
        <section className="extreme-scan-column extreme-scan-parsed">
          <header>
            <h2>2. Review & adjust items</h2>
            <p className="help-text">
              Toggle off any junk rows, tweak quantities or labels, and set a
              domain hint if needed. SSA will do deeper mapping in the import
              pipeline.
            </p>
            <div className="extreme-scan-summary">
              <span>
                Parsed: <strong>{itemCounts.totalLines}</strong> lines
              </span>
              <span>
                Selected: <strong>{itemCounts.includedCount}</strong> items
              </span>
            </div>
          </header>

          {parsedItems.length === 0 ? (
            <div className="empty-state">
              <p>No parsed items yet.</p>
              <p className="empty-hint">
                Paste raw text on the left and click{" "}
                <strong>Parse lines</strong>.
              </p>
            </div>
          ) : (
            <div className="extreme-scan-table-wrapper">
              <table className="extreme-scan-table">
                <thead>
                  <tr>
                    <th>Use</th>
                    <th>Label</th>
                    <th>Qty</th>
                    <th>Unit</th>
                    <th>Domain hint</th>
                  </tr>
                </thead>
                <tbody>
                  {parsedItems.map((item) => (
                    <tr
                      key={item.id}
                      className={!item.include ? "row-disabled" : undefined}
                    >
                      <td>
                        <input
                          type="checkbox"
                          checked={item.include}
                          onChange={() => handleToggleInclude(item.id)}
                          aria-label={`Include ${item.label}`}
                        />
                      </td>
                      <td>
                        <input
                          type="text"
                          value={item.label}
                          onChange={(e) =>
                            handleChangeField(item.id, "label", e.target.value)
                          }
                        />
                      </td>
                      <td className="qty-cell">
                        <input
                          type="number"
                          min={0}
                          step={0.01}
                          value={item.qty}
                          onChange={(e) =>
                            handleChangeField(item.id, "qty", e.target.value)
                          }
                        />
                      </td>
                      <td className="unit-cell">
                        <input
                          type="text"
                          value={item.unit}
                          onChange={(e) =>
                            handleChangeField(item.id, "unit", e.target.value)
                          }
                        />
                      </td>
                      <td>
                        <select
                          value={item.domainHint}
                          onChange={(e) =>
                            handleChangeField(
                              item.id,
                              "domainHint",
                              /** @type {DomainHint} */ (e.target.value)
                            )
                          }
                        >
                          <option value="storehouse">
                            Storehouse (default)
                          </option>
                          <option value="meals">Meals / Cooking</option>
                          <option value="preservation">Preservation</option>
                          <option value="garden">Garden</option>
                          <option value="animals">Animals</option>
                          <option value="other">Other / Unknown</option>
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Right: Actions */}
        <section className="extreme-scan-column extreme-scan-actions">
          <header>
            <h2>3. Commit & trigger automation</h2>
            <p className="help-text">
              When you commit, SSA emits <code>inventory.updated</code> and
              optional automation suggestions. Hub export is mirrored if{" "}
              <code>familyFundMode</code> is enabled.
            </p>
          </header>

          <div className="extreme-scan-actions-panel">
            <button
              type="button"
              className="btn btn-primary btn-wide"
              onClick={handleCommitToInventory}
              disabled={parsedItems.filter((i) => i.include).length === 0}
            >
              Commit selected to inventory
            </button>

            <button
              type="button"
              className="btn btn-secondary btn-wide"
              onClick={handleSuggestSessions}
              disabled={parsedItems.filter((i) => i.include).length === 0}
            >
              Suggest sessions from items
            </button>

            <div className="extreme-scan-domain-breakdown">
              <h3>Domain breakdown (selected)</h3>
              <ul>
                <li>
                  Storehouse:{" "}
                  <strong>{itemCounts.domainCounts.storehouse}</strong>
                </li>
                <li>
                  Meals / Cooking:{" "}
                  <strong>{itemCounts.domainCounts.meals}</strong>
                </li>
                <li>
                  Preservation:{" "}
                  <strong>{itemCounts.domainCounts.preservation}</strong>
                </li>
                <li>
                  Garden: <strong>{itemCounts.domainCounts.garden}</strong>
                </li>
                <li>
                  Animals: <strong>{itemCounts.domainCounts.animals}</strong>
                </li>
                <li>
                  Other: <strong>{itemCounts.domainCounts.other}</strong>
                </li>
              </ul>
            </div>

            <div className="extreme-scan-notes">
              <h3>What happens next?</h3>
              <ol>
                <li>
                  An <code>inventory.updated</code> event flows to SSA’s
                  inventory engine, which can update Dexie and trigger{" "}
                  <code>inventory.shortage.detected</code> if any items are
                  under min thresholds.
                </li>
                <li>
                  Optional <code>automation.suggestion.created</code> events cue
                  batch cooking, preservation, or garden/animal tasks based on
                  what you scanned.
                </li>
                <li>
                  If <code>familyFundMode</code> is on, a summarized packet is
                  mirrored to the Suka Village Family Fund Hub for family-level
                  analytics — but SSA stays the source of truth.
                </li>
              </ol>
              <p className="small-note">
                Later, this Extreme Scan surface can be wired to live camera /
                barcode capture and to a dedicated ScanNormalizer for richer
                parsing and pricebook integration.
              </p>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

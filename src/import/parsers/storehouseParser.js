// src/import/parsers/storehouseParser.js
// Minimal parser bridge used by import pages and CI browser smoke.

function normalizeItem(item) {
  if (!item || typeof item !== "object") {
    return {
      name: "Imported item",
      qty: null,
      unit: null,
      storage: null,
      category: null,
      reorderPoint: null,
      reorderQty: null,
      notes: null,
      expiresOn: null,
    };
  }

  return {
    name: String(item.name || item.itemName || "Imported item"),
    qty: Number.isFinite(Number(item.qty)) ? Number(item.qty) : null,
    unit: item.unit ? String(item.unit) : null,
    storage: item.storage ? String(item.storage) : null,
    category: item.category ? String(item.category) : null,
    reorderPoint: Number.isFinite(Number(item.reorderPoint)) ? Number(item.reorderPoint) : null,
    reorderQty: Number.isFinite(Number(item.reorderQty)) ? Number(item.reorderQty) : null,
    notes: item.notes ? String(item.notes) : null,
    expiresOn: item.expiresOn ? String(item.expiresOn) : null,
  };
}

async function parse(raw = {}, meta = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const items = Array.isArray(source.items)
    ? source.items.map(normalizeItem)
    : source.item
    ? [normalizeItem(source.item)]
    : [];

  return {
    type: "storehouse_import",
    domain: "storehouse",
    title: String(meta.title || source.title || "Imported storehouse data"),
    summary: String(source.summary || "Storehouse import"),
    location: source.location ? String(source.location) : null,
    items,
    replenishmentNotes: source.replenishmentNotes ? String(source.replenishmentNotes) : null,
    tags: Array.isArray(source.tags) ? source.tags.map((x) => String(x)) : [],
  };
}

const storehouseParser = {
  parse,
  parseStorehouse: parse,
};

export default storehouseParser;

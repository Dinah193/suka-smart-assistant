import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("ux polish accessibility contract", () => {
  it("keeps new prep checklist control labels for mobile/a11y", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/pages/mealplanner/PrepChecklistGenerator.jsx"),
      "utf8"
    );

    expect(source).toContain('aria-label="Checklist source"');
    expect(source).toContain('aria-label="Search prep tasks"');
    expect(source).toContain('aria-label="Filter by station"');
    expect(source).toContain('aria-label="Sort prep tasks"');
  });

  it("keeps storehouse quick-add and row action labels", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/pages/storehouse/planner/StorehouseInventoryTable.jsx"),
      "utf8"
    );

    expect(source).toContain('aria-label="Quick add item name"');
    expect(source).toContain('aria-label="Quick add quantity"');
    expect(source).toContain('aria-label="Quick add unit"');
    expect(source).toContain('aria-label={`Quantity for ${row.itemName}`}');
    expect(source).toContain('aria-label={`Remove ${row.itemName}`}');
    expect(source).toContain('role="alert"');
  });
});

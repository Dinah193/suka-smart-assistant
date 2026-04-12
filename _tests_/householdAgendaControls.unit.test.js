import { describe, expect, it } from "vitest";

import {
  areAgendaFiltersEqual,
  buildAppliedAgendaSummary,
  normalizeAppliedAgendaFilters,
} from "../src/utils/householdAgendaControls.js";

describe("householdAgendaControls", () => {
  describe("normalizeAppliedAgendaFilters", () => {
    it("normalizes person and preserves provided filter/sort values", () => {
      const normalized = normalizeAppliedAgendaFilters({
        filters: {
          person: "  Member-Alpha  ",
          module: "cleaning",
          priority: "high",
          status: "blocked",
        },
        sortBy: "status",
        sortDirection: "asc",
      });

      expect(normalized).toEqual({
        person: "member-alpha",
        module: "cleaning",
        priority: "high",
        status: "blocked",
        sortBy: "status",
        sortDirection: "asc",
      });
    });

    it("falls back to defaults when applied payload is missing fields", () => {
      const normalized = normalizeAppliedAgendaFilters({});

      expect(normalized).toEqual({
        person: "",
        module: "",
        priority: "",
        status: "",
        sortBy: "dueAt",
        sortDirection: "desc",
      });
    });
  });

  describe("areAgendaFiltersEqual", () => {
    it("returns true for equivalent filter objects", () => {
      expect(
        areAgendaFiltersEqual(
          {
            person: "member-alpha",
            module: "meal",
            priority: "high",
            status: "blocked",
            sortBy: "status",
            sortDirection: "asc",
          },
          {
            person: "member-alpha",
            module: "meal",
            priority: "high",
            status: "blocked",
            sortBy: "status",
            sortDirection: "asc",
          }
        )
      ).toBe(true);
    });

    it("returns false when any filter field differs", () => {
      expect(
        areAgendaFiltersEqual(
          {
            person: "member-alpha",
            module: "meal",
            priority: "high",
            status: "blocked",
            sortBy: "status",
            sortDirection: "asc",
          },
          {
            person: "member-alpha",
            module: "meal",
            priority: "normal",
            status: "blocked",
            sortBy: "status",
            sortDirection: "asc",
          }
        )
      ).toBe(false);
    });

    it("returns false when either side is missing", () => {
      expect(areAgendaFiltersEqual(null, {})).toBe(false);
      expect(areAgendaFiltersEqual({}, undefined)).toBe(false);
    });
  });

  describe("buildAppliedAgendaSummary", () => {
    it("formats summary with defaults when applied payload is missing", () => {
      expect(buildAppliedAgendaSummary(undefined)).toBe(
        "Applied: all modules | sort dueAt:desc"
      );
    });

    it("formats summary with all provided applied fields", () => {
      expect(
        buildAppliedAgendaSummary({
          filters: {
            person: "  Member-Alpha  ",
            module: "cleaning",
            priority: "high",
            status: "blocked",
          },
          sortBy: "status",
          sortDirection: "asc",
        })
      ).toBe(
        "Applied: cleaning | high priority | blocked status | person member-alpha | sort status:asc"
      );
    });
  });
});

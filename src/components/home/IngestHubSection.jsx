// src/components/home/IngestHubSection.jsx
/* eslint-disable react/prop-types */
import React from "react";
import DashboardSection from "@/components/layout/DashboardSection";
import { HOME_COPY } from "@/copy/home.copy";

const cx = (...a) => a.filter(Boolean).join(" ");

/**
 * IngestHubSection
 * - Wraps “Bring Things Into Your Household”
 * - Lays out Scan + Seed side-by-side for above-the-fold density
 * - Leaves Recipe as a separate card so Home can pair Recipe beside Meat Animals (2-up)
 *
 * Props:
 * - id?: string
 * - tone?: "default"|"alt"|"brand"
 * - scanCard: ReactNode (required)
 * - seedCard: ReactNode (required)
 * - actions?: DashboardSection actions
 * - collapsible?: boolean
 * - defaultCollapsed?: boolean
 */
export default function IngestHubSection({
  id = "ingest-hub",
  tone = "default",
  scanCard,
  seedCard,
  actions = [],
  collapsible = true,
  defaultCollapsed = false,
}) {
  return (
    <DashboardSection
      id={id}
      title={HOME_COPY.ingestHub.title}
      subtitle={HOME_COPY.ingestHub.subtitle}
      tone={tone}
      collapsible={collapsible}
      defaultCollapsed={defaultCollapsed}
      actions={actions}
    >
      {/* 2-up row (Scan | Seeds) */}
      <div className={cx("section-grid", "half")}>
        <div className="min-w-0">{scanCard}</div>
        <div className="min-w-0">{seedCard}</div>
      </div>
    </DashboardSection>
  );
}

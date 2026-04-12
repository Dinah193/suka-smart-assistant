import React from "react";

function cx(...parts) {
  return parts.filter(Boolean).join(" ");
}

const toneByStatus = {
  request: "text-[var(--ssa-collab-request)]",
  assigned: "text-[var(--ssa-collab-assigned)]",
  complete: "text-[var(--ssa-collab-complete)]",
  blocked: "text-[var(--ssa-collab-blocked)]",
};

const containerByVariant = {
  feed: "ssa-seasonal-card ssa-seasonal-card--feed",
  alert: "ssa-seasonal-card ssa-seasonal-card--alert border-l-4 border-l-[var(--ssa-status-warning)]",
  task: "ssa-seasonal-card ssa-seasonal-card--task",
  media: "ssa-seasonal-card ssa-seasonal-card--media",
};

export function CollaborationChip({ household, status = "request" }) {
  return (
    <span className={cx("ssa-hero-chip", toneByStatus[status])}>
      {household} · {status}
    </span>
  );
}

export function SSACard({
  title,
  subtitle,
  children,
  variant = "feed",
  household,
  collaborationStatus,
  meta,
  media,
  actions,
  season = "spring",
}) {
  return (
    <article
      className={cx("ssa-hero-wrap p-4", containerByVariant[variant])}
      data-ssa-season={season}
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="ssa-hero-title text-lg">{title}</h3>
          {subtitle ? <p className="ssa-hero-subtitle">{subtitle}</p> : null}
        </div>
        {household ? (
          <CollaborationChip household={household} status={collaborationStatus} />
        ) : null}
      </header>

      {media ? <div className="mt-3 overflow-hidden rounded-[var(--ssa-radius-card)]">{media}</div> : null}

      {meta ? <div className="mt-2 text-xs text-[var(--ssa-text-secondary)]">{meta}</div> : null}

      <div className="mt-3 text-sm text-[var(--ssa-text-primary)]">{children}</div>

      {actions ? <footer className="mt-3 ssa-hero-actions">{actions}</footer> : null}
    </article>
  );
}

export default SSACard;

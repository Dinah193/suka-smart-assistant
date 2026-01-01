// src/services/ingest/ImportRouter.js
// -----------------------------------------------------------------------------
// ImportRouter
// -----------------------------------------------------------------------------
// Routes an artifact into a domain parser.
// Deterministic heuristic routing:
// - domain hint from artifact.domain/meta
// - if unknown, scan planning/storehouse/homestead lexicons for strong terms
// -----------------------------------------------------------------------------

/* eslint-disable no-console */

import { db } from "@/services/db";
import LayerRegistry from "@/services/layers/LayerRegistry";

import cookingParser from "@/services/ingest/parsers/cookingParser";
import cleaningParser from "@/services/ingest/parsers/cleaningParser";
import gardenParser from "@/services/ingest/parsers/gardenParser";
import animalsParser from "@/services/ingest/parsers/animalsParser";

function str(x) {
  return String(x || "").trim();
}

function getArtifactText(artifact) {
  const p = artifact?.payload || {};
  const t =
    p.text ||
    (p.json ? JSON.stringify(p.json) : "") ||
    p.url ||
    (p.fileMeta ? JSON.stringify(p.fileMeta) : "");
  return String(t || "");
}

function rankDomainFromPlanningLexicon(text) {
  const hits = [];
  for (const lexId of ["planning"]) {
    const matches = LayerRegistry.scanTextWithLexicon({ text, lexiconIdOrDomain: lexId, maxMatches: 80 });
    for (const m of matches) {
      for (const methodId of m.methodIds || []) {
        hits.push({ methodId, boost: m.boost || 0 });
      }
    }
  }
  // Heuristic: map planning pattern IDs to top-level domains by prefix/tag
  let score = { cooking: 0, cleaning: 0, garden: 0, animals: 0, storehouse: 0, homestead: 0 };
  for (const h of hits) {
    const id = str(h.methodId);
    const b = Number(h.boost || 0) + 1;
    if (id.startsWith("planning:meals") || id.includes("meals")) score.cooking += b;
    if (id.startsWith("planning:storehouse") || id.includes("storehouse") || id.includes("pantry")) score.storehouse += b;
    if (id.startsWith("planning:homestead") || id.includes("homestead") || id.includes("garden")) score.homestead += b;
    if (id.includes("animal")) score.animals += b;
  }
  const best = Object.entries(score).sort((a,b)=>b[1]-a[1])[0];
  return best && best[1] > 0 ? best[0] : null;
}

export async function routeArtifact(artifactOrId, { forceDomain } = {}) {
  await LayerRegistry.init();

  const artifact =
    typeof artifactOrId === "number" || typeof artifactOrId === "string"
      ? await db.artifacts.get(artifactOrId)
      : artifactOrId;

  if (!artifact) throw new Error("ImportRouter: artifact not found");

  const domainHint = str(forceDomain) || str(artifact.domain) || str(artifact?.meta?.domainHint) || "unknown";
  const text = getArtifactText(artifact);

  let domain = domainHint;
  if (domain === "unknown") {
    const inferred = rankDomainFromPlanningLexicon(text);
    domain = inferred || "cooking"; // best-effort fallback: cooking is most common
  }

  switch (domain) {
    case "cleaning":
      return cleaningParser(artifact);
    case "garden":
      return gardenParser(artifact);
    case "animals":
      return animalsParser(artifact);
    case "storehouse":
    case "homestead":
      // for MVP, we route storehouse/homestead imports into cooking parser unless dedicated parsers added
      return cookingParser(artifact, { domainOverride: domain });
    case "cooking":
    default:
      return cookingParser(artifact);
  }
}

export default { routeArtifact };

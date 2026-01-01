// src/services/ingest/parsers/cookingParser.js
// -----------------------------------------------------------------------------
// cookingParser
// -----------------------------------------------------------------------------
// Input: artifact record (L0)
// Output: parsed_candidates (L1) + method_maps (L2) + emitted events
// Deterministic: lexicon phrase scan only.
// -----------------------------------------------------------------------------

/* eslint-disable no-console */

import { db } from "@/services/db";
import { emit } from "@/services/events/eventBus";
import LayerRegistry from "@/services/layers/LayerRegistry";


function nowIso() { return new Date().toISOString(); }
function str(x){ return String(x||"").trim(); }

function getArtifactText(artifact){
  const p = artifact?.payload || {};
  const t = p.text || (p.json ? JSON.stringify(p.json) : "") || p.url || (p.fileMeta ? JSON.stringify(p.fileMeta) : "");
  return String(t || "");
}

function computeConfidence({ boost = 0, phrase = "" } = {}) {
  // Deterministic, bounded confidence.
  const len = Math.min(24, String(phrase || "").length);
  const lenFactor = len / 24; // 0..1
  const boostFactor = Math.max(-5, Math.min(10, Number(boost || 0))) / 10; // -0.5..1
  const base = 0.35 + 0.25 * lenFactor + 0.35 * Math.max(0, boostFactor);
  return Math.max(0.05, Math.min(0.98, Number(base.toFixed(4))));
}

function rankMethodHits(matches = []) {
  const byMethod = new Map();
  for (const m of matches) {
    for (const methodKey of m.methodIds || []) {
      const key = str(methodKey);
      if (!key) continue;
      const cur = byMethod.get(key) || { methodKey: key, score: 0, phrases: [] };
      cur.score += computeConfidence({ boost: m.boost, phrase: m.phrase });
      cur.phrases.push({ phrase: m.phrase, boost: m.boost || 0, lexicon: m.lexicon });
      byMethod.set(key, cur);
    }
  }
  const ranked = Array.from(byMethod.values()).sort((a,b)=>b.score-a.score);
  // normalize into confidence 0..1
  const max = ranked[0]?.score || 1;
  return ranked.map((r)=>({
    methodKey: r.methodKey,
    confidence: Math.max(0.05, Math.min(0.99, Number((r.score / max).toFixed(4)))),
    evidence: r.phrases.slice(0, 8),
  }));
}


export default async function cookingParser(artifact, { domainOverride } = {}) {
  await LayerRegistry.init();

  const domain = str(domainOverride || artifact?.domain || "cooking") || "cooking";
  const text = getArtifactText(artifact);

  const lexMatches = [
    ...LayerRegistry.scanTextWithLexicon({ text, lexiconIdOrDomain: "cooking", maxMatches: 80 }),
    ...LayerRegistry.scanTextWithLexicon({ text, lexiconIdOrDomain: "meals", maxMatches: 50 }),
    ...LayerRegistry.scanTextWithLexicon({ text, lexiconIdOrDomain: "preservation", maxMatches: 40 }),
    ...LayerRegistry.scanTextWithLexicon({ text, lexiconIdOrDomain: "lean", maxMatches: 30 }),
    ...LayerRegistry.scanTextWithLexicon({ text, lexiconIdOrDomain: "cultural", maxMatches: 20 }),
  ];

  const ranked = rankMethodHits(lexMatches).slice(0, 10);

  const candidate = {
    artifactId: artifact.id,
    domain,
    parser: "cookingParser",
    fingerprint: artifact.fingerprint,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    status: "parsed",
    candidateType: "text_intent",
    entities: {
      rawText: text,
      // MVP: entity extraction is lexicon-driven; richer extraction can be added later.
      mentions: lexMatches.slice(0, 30).map((m) => ({
        phrase: m.phrase,
        methodIds: m.methodIds || [],
        source: m.source,
        lexicon: m.lexicon,
      })),
    },
    unknowns: [],
  };

  const candidateId = await db.parsed_candidates.add(candidate);

  emit("import.parsed", {
    artifactId: artifact.id,
    candidateId,
    domain,
    parser: "cookingParser",
    ts: nowIso(),
  });

  // Write method maps (L2)
  const methodMapIds = [];
  for (const r of ranked) {
    const rec = {
      artifactId: artifact.id,
      candidateId,
      domain,
      methodKey: r.methodKey,
      confidence: r.confidence,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      status: "mapped",
      evidence: r.evidence,
    };
    const id = await db.method_maps.add(rec);
    methodMapIds.push(id);
  }

  emit("import.mapped", {
    artifactId: artifact.id,
    candidateId,
    domain,
    methodMapIds,
    top: ranked[0] || null,
    ts: nowIso(),
  });

  return {
    ok: true,
    domain,
    artifactId: artifact.id,
    candidateId,
    methodMapIds,
    ranked,
  };
}

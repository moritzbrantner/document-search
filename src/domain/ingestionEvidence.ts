import type { ExtractedDocument } from "./types";

export interface IngestionEvidence {
  parsedDocuments: number;
  extractedParagraphs: number;
  parseDurationMs: number;
  indexState: "rebuilt-on-search";
}

export function createIngestionEvidence(
  documents: ExtractedDocument[],
  parseDurationMs: number,
): IngestionEvidence {
  return {
    parsedDocuments: documents.length,
    extractedParagraphs: documents.reduce(
      (total, document) => total + document.paragraphs.length,
      0,
    ),
    parseDurationMs: normalizeDuration(parseDurationMs),
    indexState: "rebuilt-on-search",
  };
}

export function formatIngestionEvidence(evidence: IngestionEvidence): string {
  return `Parsed ${evidence.parsedDocuments} document(s) / ${evidence.extractedParagraphs} paragraph(s) in ${evidence.parseDurationMs.toFixed(1)} ms. Index is rebuilt on demand per query.`;
}

function normalizeDuration(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return 0;
  }
  return Math.round(durationMs * 10) / 10;
}

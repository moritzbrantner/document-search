import type { CorpusSnapshot, ExtractedDocument } from "../domain/types";

export function createCorpusSnapshot(documents: ExtractedDocument[]): CorpusSnapshot {
  return {
    schemaVersion: 1,
    documents,
    exportedAt: new Date().toISOString(),
  };
}

export function serializeCorpusSnapshot(documents: ExtractedDocument[]): string {
  return JSON.stringify(createCorpusSnapshot(documents), null, 2);
}

export function parseCorpusSnapshot(json: string): CorpusSnapshot {
  const parsed = JSON.parse(json) as Partial<CorpusSnapshot>;
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.documents)) {
    throw new Error("Unsupported corpus snapshot.");
  }
  return parsed as CorpusSnapshot;
}

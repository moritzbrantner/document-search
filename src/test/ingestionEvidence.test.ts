import { expect, test } from "bun:test";
import { createIngestionEvidence, formatIngestionEvidence } from "../domain/ingestionEvidence";
import type { ExtractedDocument } from "../domain/types";

test("ingestion evidence reports parsed documents paragraphs and bounded duration", () => {
  const evidence = createIngestionEvidence([fakeDocument("a", 2), fakeDocument("b", 3)], 12.345);

  expect(evidence).toEqual({
    parsedDocuments: 2,
    extractedParagraphs: 5,
    parseDurationMs: 12.3,
    indexState: "rebuilt-on-search",
  });
  expect(formatIngestionEvidence(evidence)).toBe(
    "Parsed 2 document(s) / 5 paragraph(s) in 12.3 ms. Index is rebuilt on demand per query.",
  );
});

test("ingestion evidence normalizes invalid durations", () => {
  expect(createIngestionEvidence([], Number.NaN).parseDurationMs).toBe(0);
  expect(createIngestionEvidence([], -1).parseDurationMs).toBe(0);
});

function fakeDocument(id: string, paragraphCount: number): ExtractedDocument {
  return {
    id,
    title: id,
    html: "",
    text: "",
    paragraphs: Array.from({ length: paragraphCount }, (_, ordinal) => ({
      id: `${id}:p${ordinal}`,
      documentId: id,
      ordinal,
      text: "paragraph",
      headingPath: [],
    })),
    importedAt: "2026-09-17T00:00:00.000Z",
    stats: {
      words: 0,
      sentences: 0,
      paragraphs: paragraphCount,
      uniqueWords: 0,
    },
  };
}

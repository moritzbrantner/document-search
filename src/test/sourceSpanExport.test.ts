import { expect, test } from "bun:test";

import type { ExtractedDocument } from "../domain/types";
import { createSourceSpanBatch } from "../storage/sourceSpanExport";

test("source-span export preserves exact document and paragraph provenance", async () => {
  const document = fakeDocument("doc-1", "Café.\n\nTruth.");
  const batch = await createSourceSpanBatch([document], "git:abc123");

  expect(batch.schema).toBe("source_span_interchange");
  expect(batch.schemaVersion).toBe(1);
  expect(batch.producer).toEqual({
    name: "document-search",
    revision: "git:abc123",
  });
  expect(batch.sources).toHaveLength(1);
  expect(batch.sources[0]?.revision).toBe(batch.sources[0]?.contentHash);
  expect(batch.sources[0]?.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);

  expect(batch.spans.map((span) => span.id)).toEqual(["doc-1:p0", "doc-1:p1"]);
  expect(batch.spans[0]?.locator).toEqual({
    kind: "text",
    byteStart: 0,
    byteEnd: 6,
    paragraphOrdinal: 0,
    headingPath: [],
  });
  expect(batch.spans[1]?.locator).toEqual({
    kind: "text",
    byteStart: 8,
    byteEnd: 14,
    paragraphOrdinal: 1,
    headingPath: [],
  });
  expect(batch.spans.every((span) => /^sha256:[0-9a-f]{64}$/.test(span.contentHash))).toBe(true);
});

test("source-span export fails closed when stored paragraph text cannot be located", async () => {
  const document = fakeDocument("doc-1", "Original text.");
  document.paragraphs[0]!.text = "Drifted text.";

  await expect(createSourceSpanBatch([document], "git:abc123")).rejects.toThrow(
    "refusing to emit ambiguous provenance",
  );
});

test("source-span export requires an exact producer revision", async () => {
  await expect(createSourceSpanBatch([fakeDocument("doc-1", "Truth.")], "   ")).rejects.toThrow(
    "producer revision",
  );
});

function fakeDocument(id: string, text: string): ExtractedDocument {
  return {
    id,
    title: "Example",
    sourceUri: "https://example.test/source",
    html: `<p>${text}</p>`,
    text,
    paragraphs: text.split("\n\n").map((paragraph, ordinal) => ({
      id: `${id}:p${ordinal}`,
      documentId: id,
      ordinal,
      text: paragraph,
      headingPath: [],
    })),
    importedAt: "2026-09-21T08:00:00.000Z",
    stats: {
      words: text.split(/\s+/).length,
      sentences: text.split(".").filter(Boolean).length,
      paragraphs: text.split("\n\n").length,
      uniqueWords: new Set(text.toLowerCase().match(/[a-z]+/g)).size,
    },
  };
}

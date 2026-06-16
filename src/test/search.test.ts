import { expect, test } from "bun:test";
import { searchCorpus } from "../domain/search";
import {
  createCorpusSnapshot,
  parseCorpusSnapshot,
  serializeCorpusSnapshot,
} from "../storage/exportImport";
import type { ExtractedDocument } from "../domain/types";

test("searchCorpus returns paragraph-level results from text-index-wasm", async () => {
  const results = await searchCorpus(
    [
      fakeDocument("doc-1", "Climate Memo", "Climate policy needs funding.\n\nMarkets price risk."),
      fakeDocument("doc-2", "Recipe", "Recipe notes and pantry items."),
    ],
    {
      query: "climate funding",
      topK: 5,
      mode: "hybrid",
      requireQuotedPhrases: true,
    },
  );

  expect(results[0]?.documentId).toBe("doc-1");
  expect(results[0]?.paragraphOrdinal).toBe(0);
  expect(results[0]?.snippet).toContain("Climate policy");
});

test("searchCorpus filters ranked candidates by quoted phrases", async () => {
  const results = await searchCorpus(
    [
      fakeDocument(
        "doc-1",
        "Exact",
        "Climate policy needs public funding.\n\nClimate funding appears separately.",
      ),
      fakeDocument("doc-2", "Near", "Climate policy needs private finance."),
    ],
    {
      query: '"climate policy" "public funding" finance',
      topK: 5,
      mode: "hybrid",
      requireQuotedPhrases: true,
    },
  );

  expect(results).toHaveLength(1);
  expect(results[0]?.documentId).toBe("doc-1");
  expect(results[0]?.exactPhraseMatches).toEqual(["climate policy", "public funding"]);
});

test("export/import round-trips CorpusSnapshot", () => {
  const documents = [fakeDocument("doc-1", "Round Trip", "Exported corpus text.")];
  const snapshot = createCorpusSnapshot(documents);
  const parsed = parseCorpusSnapshot(serializeCorpusSnapshot(documents));

  expect(snapshot.schemaVersion).toBe(1);
  expect(parsed.schemaVersion).toBe(1);
  expect(parsed.documents).toEqual(documents);
});

function fakeDocument(id: string, title: string, text: string): ExtractedDocument {
  return {
    id,
    title,
    html: `<p>${text}</p>`,
    text,
    paragraphs: text.split("\n\n").map((paragraph, ordinal) => ({
      id: `${id}:p${ordinal}`,
      documentId: id,
      ordinal,
      text: paragraph,
      headingPath: [],
    })),
    importedAt: "2026-06-13T00:00:00.000Z",
    stats: {
      words: text.split(/\s+/).length,
      sentences: text.split(".").filter(Boolean).length,
      paragraphs: text.split("\n\n").length,
      uniqueWords: new Set(text.toLowerCase().match(/[a-z]+/g)).size,
    },
  };
}

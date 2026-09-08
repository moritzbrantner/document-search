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

test("searchCorpus delegates quoted phrase constraints to text-index", async () => {
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

test("required phrases are applied before top-K truncation", async () => {
  const decoys = Array.from({ length: 16 }, (_, index) =>
    fakeDocument(
      `decoy-${index}`,
      `Decoy ${index}`,
      "climate risk climate risk policy market policy market public finance public finance funding budget funding",
    ),
  );
  const exact = fakeDocument(
    "exact",
    "Exact phrase result",
    "A concise climate policy note depends on public funding.",
  );

  const results = await searchCorpus([...decoys, exact], {
    query: '"climate policy" "public funding"',
    topK: 1,
    mode: "lexical",
    requireQuotedPhrases: true,
  });

  expect(results).toHaveLength(1);
  expect(results[0]?.documentId).toBe("exact");
  expect(results[0]?.exactPhraseMatches).toEqual(["climate policy", "public funding"]);
});

test("typo-tolerant lexical search recovers a transposed term and reports the correction", async () => {
  const results = await searchCorpus(
    [
      fakeDocument("strategy", "Strategy", "Medieval strategy depends on disciplined formations."),
      fakeDocument("recipe", "Recipe", "Kitchen recipes depend on ingredients."),
    ],
    {
      query: "stratgey formations",
      topK: 5,
      mode: "lexical",
      requireQuotedPhrases: true,
      fuzzy: true,
    },
  );

  expect(results[0]?.documentId).toBe("strategy");
  expect(results[0]?.fuzzyMatches).toContainEqual({
    queryTerm: "stratgey",
    matchedTerm: "strategy",
    editDistance: 1,
    similarity: 0.875,
  });
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

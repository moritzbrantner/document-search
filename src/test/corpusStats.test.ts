import { expect, test } from "bun:test";
import { computeCorpusStats } from "../domain/corpusStats";
import type { ExtractedDocument } from "../domain/types";

test("corpus stats count documents, words, sentences, paragraphs, and unique words", () => {
  const documents: ExtractedDocument[] = [
    fakeDocument("doc-1", "Climate policy works.", {
      words: 3,
      sentences: 1,
      paragraphs: 1,
      uniqueWords: 3,
    }),
    fakeDocument("doc-2", "Policy funding works. Funding scales.", {
      words: 5,
      sentences: 2,
      paragraphs: 2,
      uniqueWords: 4,
    }),
  ];

  expect(computeCorpusStats(documents)).toMatchObject({
    documents: 2,
    words: 8,
    sentences: 3,
    paragraphs: 3,
    uniqueWords: 5,
  });
  expect(computeCorpusStats(documents).topTerms[0]).toEqual({ term: "funding", count: 2 });
});

function fakeDocument(
  id: string,
  text: string,
  stats: ExtractedDocument["stats"],
): ExtractedDocument {
  return {
    id,
    title: id,
    html: text,
    text,
    paragraphs: [],
    importedAt: "2026-06-13T00:00:00.000Z",
    stats,
  };
}

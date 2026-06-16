import { expect, test } from "bun:test";
import {
  findExactPhraseMatches,
  parsePhraseQuery,
  resultContainsAllPhrases,
} from "../domain/phraseQuery";

test("quoted phrase parser handles one phrase", () => {
  expect(parsePhraseQuery('"climate policy" funding')).toEqual({
    searchText: "climate policy funding",
    quotedPhrases: ["climate policy"],
  });
});

test("quoted phrase parser handles multiple phrases", () => {
  expect(parsePhraseQuery('"climate policy" "public funding" risk')).toEqual({
    searchText: "climate policy public funding risk",
    quotedPhrases: ["climate policy", "public funding"],
  });
});

test("quoted phrase parser treats unmatched quotes as unquoted text", () => {
  expect(parsePhraseQuery('climate "policy funding')).toEqual({
    searchText: 'climate "policy funding',
    quotedPhrases: [],
  });
});

test("quoted phrase parser handles unquoted terms", () => {
  expect(parsePhraseQuery("climate policy funding")).toEqual({
    searchText: "climate policy funding",
    quotedPhrases: [],
  });
});

test("exact phrase filtering keeps only chunks containing all phrases", () => {
  const phrases = ["climate policy", "public funding"];
  expect(findExactPhraseMatches("Climate policy depends on public   funding.", phrases)).toEqual(
    phrases,
  );
  expect(
    resultContainsAllPhrases(
      {
        documentId: "doc-1",
        documentTitle: "Doc",
        chunkId: "chunk-1",
        score: 1,
        snippet: "Climate policy depends on private finance.",
        exactPhraseMatches: [],
      },
      phrases,
    ),
  ).toBe(false);
});

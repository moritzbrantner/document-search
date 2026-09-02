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

test("quoted phrase parser ignores empty phrases without leaving search gaps", () => {
  expect(parsePhraseQuery('climate ""   policy "   " funding')).toEqual({
    searchText: "climate policy funding",
    quotedPhrases: [],
  });
});

test("quoted phrase parser normalizes phrase matching text while preserving search text", () => {
  expect(parsePhraseQuery('"ＣＬＩＭＡＴＥ   Policy"')).toEqual({
    searchText: "ＣＬＩＭＡＴＥ Policy",
    quotedPhrases: ["climate policy"],
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

test("exact phrase matching applies the same whitespace, case, and NFKC normalization", () => {
  const phrases = ["climate policy", "public funding"];
  expect(findExactPhraseMatches("ＣＬＩＭＡＴＥ   POLICY and Public\nFunding", phrases)).toEqual(phrases);
});

test("all-phrase filtering is vacuously true when no phrases were requested", () => {
  expect(
    resultContainsAllPhrases(
      {
        documentId: "doc-1",
        documentTitle: "Doc",
        chunkId: "chunk-1",
        score: 1,
        snippet: "Anything",
        exactPhraseMatches: [],
      },
      [],
    ),
  ).toBe(true);
});

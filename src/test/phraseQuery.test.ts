import { expect, test } from "bun:test";
import { findExactPhraseMatches, parsePhraseQuery } from "../domain/phraseQuery";

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

test("exact phrase highlighting applies whitespace, case, and NFKC normalization", () => {
  const phrases = ["climate policy", "public funding"];
  expect(
    findExactPhraseMatches("ＣＬＩＭＡＴＥ   POLICY and Public\nFunding", phrases),
  ).toEqual(phrases);
});

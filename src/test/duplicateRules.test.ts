import { expect, test } from "bun:test";
import {
  DEFAULT_DUPLICATE_RULE,
  dedupeDocumentsByRule,
  isDuplicateDocument,
  isDuplicateSourceUri,
  normalizeSourceKey,
} from "../domain/duplicateRules";
import type { ExtractedDocument } from "../domain/types";
import { parseDuplicateRulePreference } from "../storage/preferences";

test("parseDuplicateRulePreference defaults unknown values to same page", () => {
  expect(DEFAULT_DUPLICATE_RULE).toBe("same-page");
  expect(parseDuplicateRulePreference(null)).toBe("same-page");
  expect(parseDuplicateRulePreference("same-content")).toBe("same-content");
  expect(parseDuplicateRulePreference("other")).toBe("same-page");
});

test("same page matches normalized URLs without fragments and tracking params", () => {
  const existing = [
    fakeDocument(
      "doc-1",
      "Page",
      "https://Example.com/article?b=2&utm_source=newsletter&a=1#section",
    ),
  ];

  expect(
    isDuplicateSourceUri(
      "https://example.com/article?a=1&b=2&utm_campaign=spring",
      existing,
      "same-page",
    ),
  ).toBe(true);
});

test("same page preserves meaningful URL query params", () => {
  expect(normalizeSourceKey("https://example.com/article?page=1")).not.toBe(
    normalizeSourceKey("https://example.com/article?page=2"),
  );
});

test("same page matches non-URL source identifiers", () => {
  const existing = [fakeDocument("doc-1", "File", " Quarterly   Report.html ")];
  const candidate = fakeDocument("doc-2", "File Copy", "quarterly report.html");

  expect(isDuplicateDocument(candidate, existing, "same-page")).toBe(true);
});

test("same content matches extracted text and ignores markup differences", () => {
  const existing = [
    fakeDocument("doc-1", "First", "https://example.com/first", "Shared extracted text."),
  ];
  const candidate = fakeDocument(
    "doc-2",
    "Second",
    "https://example.com/second",
    "  shared   extracted text. ",
    "<article><strong>Shared extracted text.</strong></article>",
  );

  expect(isDuplicateDocument(candidate, existing, "same-content")).toBe(true);
});

test("same content allows changed text from the same URL", () => {
  const existing = [fakeDocument("doc-1", "Old", "https://example.com/article", "Old text.")];
  const candidate = fakeDocument("doc-2", "New", "https://example.com/article", "New text.");

  expect(isDuplicateDocument(candidate, existing, "same-content")).toBe(false);
});

test("same page or content matches either source URI or extracted text", () => {
  const existing = [fakeDocument("doc-1", "Old", "https://example.com/article", "Shared text.")];
  const sameSource = fakeDocument("doc-2", "New", "https://example.com/article", "Changed text.");
  const sameText = fakeDocument("doc-3", "Copy", "https://example.com/copy", "Shared text.");

  expect(isDuplicateDocument(sameSource, existing, "same-page-or-content")).toBe(true);
  expect(isDuplicateDocument(sameText, existing, "same-page-or-content")).toBe(true);
});

test("snapshot dedupe uses the selected duplicate rule", () => {
  const documents = [
    fakeDocument("doc-1", "Old", "https://example.com/article", "Old text."),
    fakeDocument("doc-2", "New", "https://example.com/article", "New text."),
  ];

  expect(dedupeDocumentsByRule(documents, "same-page").map((document) => document.id)).toEqual([
    "doc-1",
  ]);
  expect(dedupeDocumentsByRule(documents, "same-content").map((document) => document.id)).toEqual([
    "doc-1",
    "doc-2",
  ]);
});

function fakeDocument(
  id: string,
  title: string,
  sourceUri: string,
  text = "Extracted text.",
  html = `<p>${text}</p>`,
): ExtractedDocument {
  return {
    id,
    title,
    sourceUri,
    html,
    text,
    paragraphs: [
      {
        id: `${id}:p0`,
        documentId: id,
        ordinal: 0,
        text,
        headingPath: [],
      },
    ],
    importedAt: "2026-06-13T00:00:00.000Z",
    stats: {
      words: text.split(/\s+/).filter(Boolean).length,
      sentences: text.split(".").filter(Boolean).length,
      paragraphs: 1,
      uniqueWords: new Set(text.toLowerCase().match(/[a-z]+/g)).size,
    },
  };
}

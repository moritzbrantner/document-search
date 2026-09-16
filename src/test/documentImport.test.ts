import { expect, test } from "bun:test";
import {
  isSupportedDocument,
  parseUploadedDocument,
  SUPPORTED_DOCUMENT_ACCEPT,
} from "../domain/documentImport";
import { extractHtmlDocument } from "../domain/htmlExtraction";

const IMPORTED_AT = "2026-09-16T10:00:00.000Z";

test("document import accepts HTML, Markdown, and plain text", () => {
  expect(isSupportedDocument("article.html")).toBe(true);
  expect(isSupportedDocument("notes.md")).toBe(true);
  expect(isSupportedDocument("readme.markdown")).toBe(true);
  expect(isSupportedDocument("transcript.txt")).toBe(true);
  expect(isSupportedDocument("untitled", "text/plain")).toBe(true);
  expect(isSupportedDocument("paper.pdf", "application/pdf")).toBe(false);
  expect(SUPPORTED_DOCUMENT_ACCEPT).toContain(".md");
});

test("Markdown is normalized through the existing HTML extraction path", () => {
  const input = parseUploadedDocument({
    name: "retrieval-notes.md",
    mimeType: "text/markdown",
    importedAt: IMPORTED_AT,
    content: `# Retrieval notes

Search should keep **ranking authority** in the index.

- lexical retrieval
- semantic retrieval

> Keep ingestion local-first.`,
  });
  const document = extractHtmlDocument(input);

  expect(document.title).toBe("retrieval-notes");
  expect(document.sourceUri).toBe("retrieval-notes.md");
  expect(document.paragraphs.map((paragraph) => paragraph.text)).toEqual([
    "Retrieval notes",
    "Search should keep ranking authority in the index.",
    "lexical retrieval",
    "semantic retrieval",
    "Keep ingestion local-first.",
  ]);
});

test("Markdown preserves literal punctuation while removing paired formatting", () => {
  const input = parseUploadedDocument({
    name: "syntax-notes.md",
    mimeType: "text/markdown",
    importedAt: IMPORTED_AT,
    content:
      "Use foo_bar and 2 * 3. Keep **ranking authority**, _local state_, ~~old label~~, and `query_id`.",
  });
  const document = extractHtmlDocument(input);

  expect(document.paragraphs[0]?.text).toBe(
    "Use foo_bar and 2 * 3. Keep ranking authority, local state, old label, and query_id.",
  );
});

test("Markdown headings preserve attached hashes and remove closing markers", () => {
  const input = parseUploadedDocument({
    name: "heading-notes.md",
    mimeType: "text/markdown",
    importedAt: IMPORTED_AT,
    content: "# C#\n\n## issue#\n\n### Closed heading ###",
  });
  const document = extractHtmlDocument(input);

  expect(document.paragraphs.map((paragraph) => paragraph.text)).toEqual([
    "C#",
    "issue#",
    "Closed heading",
  ]);
});

test("plain text is escaped before HTML extraction", () => {
  const input = parseUploadedDocument({
    name: "meeting.txt",
    importedAt: IMPORTED_AT,
    content: "First paragraph with <script>unsafe()</script>.\n\nSecond paragraph.",
  });
  const document = extractHtmlDocument(input);

  expect(document.text).toContain("First paragraph with <script>unsafe()</script>.");
  expect(document.text).toContain("Second paragraph.");
  expect(input.html).toContain("&lt;script&gt;");
});

test("unsupported uploads fail before they reach the corpus", () => {
  expect(() =>
    parseUploadedDocument({
      name: "paper.pdf",
      mimeType: "application/pdf",
      importedAt: IMPORTED_AT,
      content: "%PDF",
    }),
  ).toThrow("Unsupported document type: paper.pdf");
});

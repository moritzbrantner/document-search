import { expect, test } from "bun:test";
import { extractHtmlDocument } from "../domain/htmlExtraction";

test("HTML extraction removes non-content nodes", () => {
  const document = extractHtmlDocument({
    html: `
      <html>
        <head><title>Hidden Test</title><style>p { color: red; }</style></head>
        <body>
          <script>secret()</script>
          <template>Template copy</template>
          <p>Visible copy</p>
        </body>
      </html>
    `,
    importedAt: "2026-06-13T00:00:00.000Z",
  });

  expect(document.title).toBe("Hidden Test");
  expect(document.text).toContain("Visible copy");
  expect(document.text).not.toContain("secret");
  expect(document.text).not.toContain("Template copy");
});

test("HTML extraction keeps headings, paragraphs, list items, table cells, and blockquotes", () => {
  const document = extractHtmlDocument({
    html: `
      <h1>Climate Report</h1>
      <p>Policy details.</p>
      <ul><li>Funding line.</li></ul>
      <table><tr><th>Region</th><td>North</td></tr></table>
      <blockquote>Quoted evidence.</blockquote>
    `,
    importedAt: "2026-06-13T00:00:00.000Z",
  });

  expect(document.paragraphs.map((paragraph) => paragraph.text)).toEqual([
    "Climate Report",
    "Policy details.",
    "Funding line.",
    "Region",
    "North",
    "Quoted evidence.",
  ]);
  expect(document.paragraphs[1]?.headingPath).toEqual(["Climate Report"]);
});

test("HTML extraction avoids duplicated nested block text", () => {
  const document = extractHtmlDocument({
    html: "<article><blockquote><p>Nested quotation.</p></blockquote><p>Separate paragraph.</p></article>",
    importedAt: "2026-06-13T00:00:00.000Z",
  });

  expect(document.paragraphs.map((paragraph) => paragraph.text)).toEqual([
    "Nested quotation.",
    "Separate paragraph.",
  ]);
});

test("HTML extraction normalizes whitespace while preserving paragraph boundaries", () => {
  const document = extractHtmlDocument({
    html: "<p>First   paragraph<br>line.</p><p> Second\tparagraph. </p>",
    importedAt: "2026-06-13T00:00:00.000Z",
  });

  expect(document.paragraphs.map((paragraph) => paragraph.text)).toEqual([
    "First paragraph line.",
    "Second paragraph.",
  ]);
  expect(document.text).toBe("First paragraph line.\n\nSecond paragraph.");
});

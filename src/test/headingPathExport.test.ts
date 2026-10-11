import { expect, test } from "bun:test";

import { extractHtmlDocument } from "../domain/htmlExtraction";
import type { SourceSpanBatchV1 } from "../domain/types";
import {
  createCorpusCoreBatch,
  parseCorpusCoreBatch,
  serializeCorpusCoreBatch,
} from "../storage/corpusCoreExport";
import { serializeSourceSpanBatch } from "../storage/sourceSpanExport";

const importedAt = "2026-10-11T00:00:00.000Z";
const producerRevision = "git:heading-path-regression";

const cases = [
  {
    name: "first heading is h2",
    html: "<h2>A</h2><p>x</p>",
    expectedPaths: [["A"], ["A"]],
  },
  {
    name: "skipped levels retain ancestors and later headings replace descendants",
    html: "<h1>T</h1><h3>B</h3><p>y</p><h2>C</h2><h4>D</h4><p>z</p><h1>Reset</h1><p>done</p>",
    expectedPaths: [
      ["T"],
      ["T", "B"],
      ["T", "B"],
      ["T", "C"],
      ["T", "C", "D"],
      ["T", "C", "D"],
      ["Reset"],
      ["Reset"],
    ],
  },
];

for (const { name, html, expectedPaths } of cases) {
  test(`fallback HTML extraction emits dense heading paths in both export formats: ${name}`, async () => {
    // Bun uses the fallback tree parser; the browser test covers DOMParser separately.
    const document = extractHtmlDocument({
      id: "heading-path-regression",
      html,
      importedAt,
    });
    const extractedPaths = document.paragraphs.map((paragraph) => paragraph.headingPath);
    expect(extractedPaths).toEqual(expectedPaths);

    const sourceSpan = JSON.parse(
      await serializeSourceSpanBatch([document], producerRevision),
    ) as SourceSpanBatchV1;
    const sourcePaths = sourceSpan.spans.map((span) =>
      span.locator.kind === "text" ? span.locator.headingPath : [],
    );

    const corpusCore = parseCorpusCoreBatch(
      serializeCorpusCoreBatch(await createCorpusCoreBatch([document], producerRevision)),
    );
    const segments = corpusCore.records.flatMap((record) =>
      record.record_type === "segment" ? [record.record] : [],
    );
    const corpusPaths = segments.map(
      (segment) => JSON.parse(segment.metadata.heading_path ?? "null") as unknown,
    );

    expect(sourceSpan.schemaVersion).toBe(1);
    expect(corpusCore.schemaVersion).toBe(1);
    expect(sourceSpan.spans.map((span) => span.id)).toEqual(
      document.paragraphs.map((paragraph) => paragraph.id),
    );
    expect(sourcePaths).toEqual(expectedPaths);
    expect(corpusPaths).toEqual(expectedPaths);

    // Array.every alone ignores holes; check keys as well as serialized values.
    for (const path of [...extractedPaths, ...sourcePaths, ...corpusPaths]) {
      expect(Array.isArray(path)).toBe(true);
      if (Array.isArray(path)) {
        expect(Object.keys(path)).toHaveLength(path.length);
        expect(path.every((heading) => typeof heading === "string")).toBe(true);
        expect(path).not.toContain(null);
      }
    }
  });
}

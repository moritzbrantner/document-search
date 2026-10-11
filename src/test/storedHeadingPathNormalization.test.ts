import { expect, test } from "bun:test";

import { extractHtmlDocument } from "../domain/htmlExtraction";
import type { ExtractedDocument, SourceSpanBatchV1 } from "../domain/types";
import {
  createCorpusCoreBatch,
  parseCorpusCoreBatch,
  serializeCorpusCoreBatch,
} from "../storage/corpusCoreExport";
import { parseCorpusSnapshot, serializeCorpusSnapshot } from "../storage/exportImport";
import { serializeSourceSpanBatch } from "../storage/sourceSpanExport";

// Documents persisted before #32 carry heading paths indexed by heading level, so a
// skipped level left a hole (IndexedDB structured clone keeps it) or a null (after a
// JSON corpus snapshot round-trip). Exports must still emit the dense contract.
const importedAt = "2026-10-11T00:00:00.000Z";
const producerRevision = "git:stored-heading-path-normalization";

function sparse(entries: Record<number, string>): string[] {
  const path: string[] = [];
  for (const [index, text] of Object.entries(entries)) {
    path[Number(index)] = text;
  }
  return path;
}

const cases = [
  {
    name: "first heading is h2",
    html: "<h2>A</h2><p>x</p>",
    legacyPaths: [sparse({ 1: "A" }), sparse({ 1: "A" })],
    expectedPaths: [["A"], ["A"]],
  },
  {
    name: "h1 then h3",
    html: "<h1>T</h1><h3>B</h3><p>y</p>",
    legacyPaths: [["T"], sparse({ 0: "T", 2: "B" }), sparse({ 0: "T", 2: "B" })],
    expectedPaths: [["T"], ["T", "B"], ["T", "B"]],
  },
];

function legacyDocument(html: string, legacyPaths: string[][]): ExtractedDocument {
  const document = extractHtmlDocument({ id: "legacy-heading-paths", html, importedAt });
  expect(document.paragraphs).toHaveLength(legacyPaths.length);
  document.paragraphs.forEach((paragraph, index) => {
    paragraph.headingPath = legacyPaths[index]!;
  });
  return document;
}

async function exportedPaths(document: ExtractedDocument) {
  const sourceSpan = JSON.parse(
    await serializeSourceSpanBatch([document], producerRevision),
  ) as SourceSpanBatchV1;
  const sourcePaths = sourceSpan.spans.map((span) =>
    span.locator.kind === "text" ? (span.locator.headingPath as unknown) : undefined,
  );

  const corpusCore = parseCorpusCoreBatch(
    serializeCorpusCoreBatch(await createCorpusCoreBatch([document], producerRevision)),
  );
  const corpusPaths = corpusCore.records.flatMap((record) =>
    record.record_type === "segment"
      ? [JSON.parse(record.record.metadata.heading_path ?? "undefined") as unknown]
      : [],
  );
  return { sourcePaths, corpusPaths };
}

function expectDense(paths: unknown[]): void {
  for (const path of paths) {
    expect(Array.isArray(path)).toBe(true);
    const list = Array.isArray(path) ? (path as unknown[]) : [];
    expect(Object.keys(list)).toHaveLength(list.length);
    expect(list).not.toContain(null);
    expect(list.every((heading) => typeof heading === "string")).toBe(true);
  }
}

for (const { name, html, legacyPaths, expectedPaths } of cases) {
  test(`stored document with sparse legacy heading paths exports dense paths: ${name}`, async () => {
    // Shape of a document read back from IndexedDB (structured clone preserves holes).
    const document = legacyDocument(html, legacyPaths);
    const { sourcePaths, corpusPaths } = await exportedPaths(document);

    expect(sourcePaths).toEqual(expectedPaths);
    expect(corpusPaths).toEqual(expectedPaths);
    expectDense([...sourcePaths, ...corpusPaths]);
  });

  test(`imported corpus snapshot with null legacy heading paths exports dense paths: ${name}`, async () => {
    // Shape of a document loaded from a JSON corpus snapshot written before #32.
    const snapshotJson = serializeCorpusSnapshot([legacyDocument(html, legacyPaths)]);
    expect(snapshotJson).toContain("null");
    const [document] = parseCorpusSnapshot(snapshotJson).documents;
    expect(document).toBeDefined();
    const { sourcePaths, corpusPaths } = await exportedPaths(document!);

    expect(sourcePaths).toEqual(expectedPaths);
    expect(corpusPaths).toEqual(expectedPaths);
    expectDense([...sourcePaths, ...corpusPaths]);
  });
}

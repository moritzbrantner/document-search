import { expect, test } from "bun:test";
import {
  createDemoDocuments,
  DEMO_DOCUMENT_INPUTS,
  shouldSeedDemoCorpus,
} from "../demo/demoCorpus";

test("the demo corpus contains five deterministic searchable documents", () => {
  const documents = createDemoDocuments();

  expect(DEMO_DOCUMENT_INPUTS).toHaveLength(5);
  expect(documents).toHaveLength(5);
  expect(new Set(documents.map((document) => document.id)).size).toBe(5);
  expect(new Set(documents.map((document) => document.sourceUri)).size).toBe(5);

  for (const document of documents) {
    expect(document.id.startsWith("demo-")).toBe(true);
    expect(document.paragraphs.length).toBeGreaterThanOrEqual(3);
    expect(document.text.length).toBeGreaterThan(100);
  }
});

test("demo documents seed only on the first empty-corpus initialization", () => {
  expect(shouldSeedDemoCorpus(false, 0)).toBe(true);
  expect(shouldSeedDemoCorpus(false, 3)).toBe(false);
  expect(shouldSeedDemoCorpus(true, 0)).toBe(false);
  expect(shouldSeedDemoCorpus(true, 5)).toBe(false);
});

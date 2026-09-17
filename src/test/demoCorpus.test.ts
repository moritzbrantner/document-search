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

test("demo initialization seeds a new corpus and repairs interrupted seeding", () => {
  const demoDocuments = createDemoDocuments();

  expect(shouldSeedDemoCorpus(false, [])).toBe(true);
  expect(shouldSeedDemoCorpus(false, demoDocuments.slice(0, 2))).toBe(true);
  expect(shouldSeedDemoCorpus(false, [{ id: "user-document" }])).toBe(false);
  expect(shouldSeedDemoCorpus(true, [])).toBe(false);
  expect(shouldSeedDemoCorpus(true, demoDocuments)).toBe(false);
});

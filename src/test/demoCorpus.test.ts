import { expect, test } from "bun:test";
import { createDemoDocuments, DEMO_DOCUMENT_INPUTS } from "../demo/demoCorpus";

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

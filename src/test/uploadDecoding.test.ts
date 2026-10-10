import { createHash } from "node:crypto";

import { expect, test } from "bun:test";

import { decodeUploadedBytes, parseUploadedDocument } from "../domain/documentImport";
import { extractHtmlDocument } from "../domain/htmlExtraction";
import { createCorpusCoreBatch } from "../storage/corpusCoreExport";

const encoder = new TextEncoder();

test("valid UTF-8 with a BOM keeps the exact bytes as original and strips the BOM for import", () => {
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode("Café 😀\n")]);
  const decoded = decodeUploadedBytes(bytes);

  expect(decoded.content).toBe("Café 😀\n");
  expect(decoded.originalContent).toBe("﻿Café 😀\n");
  expect(Buffer.from(encoder.encode(decoded.originalContent!))).toEqual(Buffer.from(bytes));
});

test("malformed UTF-8 is imported but records no original", async () => {
  const decoded = decodeUploadedBytes(new Uint8Array([0x61, 0xff, 0x62]));
  expect(decoded.content).toBe("a�b");
  expect(decoded.originalContent).toBeNull();

  const input = parseUploadedDocument({
    name: "broken.txt",
    content: decoded.content,
    originalContent: decoded.originalContent,
    importedAt: "2026-10-01T00:00:00.000Z",
  });
  expect(input.original).toBeUndefined();

  const batch = await createCorpusCoreBatch([extractHtmlDocument(input)], "git:test");
  const asset = batch.records.find((entry) => entry.record_type === "asset");
  expect(asset?.record_type === "asset" && asset.record.metadata.content_basis).toBe(
    "normalized_html",
  );
});

test("the asset hash of a BOM upload is the hash of the uploaded bytes", async () => {
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode("Plain text.\n")]);
  const decoded = decodeUploadedBytes(bytes);
  const input = parseUploadedDocument({
    name: "bom.txt",
    content: decoded.content,
    originalContent: decoded.originalContent,
    importedAt: "2026-10-01T00:00:00.000Z",
  });
  const batch = await createCorpusCoreBatch([extractHtmlDocument(input)], "git:test");
  const asset = batch.records.find((entry) => entry.record_type === "asset");

  expect(asset?.record_type === "asset" && asset.record.content.hash).toBe(
    createHash("sha256").update(bytes).digest("hex"),
  );
  expect(asset?.record_type === "asset" && asset.record.content.byte_length).toBe(bytes.byteLength);
});

test("paragraphs that drifted from the extracted text fail closed even if still a substring", async () => {
  const document = extractHtmlDocument({
    id: "drift",
    html: "<p>alpha beta</p><p>gamma</p>",
    importedAt: "2026-10-01T00:00:00.000Z",
  });
  const drifted = {
    ...document,
    paragraphs: document.paragraphs.map((paragraph) =>
      paragraph.ordinal === 0 ? { ...paragraph, text: "beta" } : paragraph,
    ),
  };

  await expect(createCorpusCoreBatch([drifted], "git:test")).rejects.toThrow(/reconstruct/);
});

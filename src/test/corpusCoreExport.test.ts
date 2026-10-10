// Acceptance tests for issue #19 (corpus-core export). Every expected value here
// is derived from the issue contract and computed independently (node:crypto,
// python3 hashlib), never by running the implementation.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

import { parseUploadedDocument } from "../domain/documentImport";
import { extractHtmlDocument } from "../domain/htmlExtraction";
import type { ExtractedDocument } from "../domain/types";
import {
  createCorpusCoreBatch,
  parseCorpusCoreBatch,
  serializeCorpusCoreBatch,
} from "../storage/corpusCoreExport";

// ---------------------------------------------------------------------------
// Local views of the corpus-core serde shapes (snake_case, tagged enums).
// ---------------------------------------------------------------------------

interface ItemRef {
  record_type: "source" | "asset" | "segment" | "representation";
  id: string;
}

interface Span {
  start: number;
  end: number;
}

interface ProvenanceView {
  operation: string;
  producer: string;
  producer_version: string | null;
  inputs: ItemRef[];
  parameters_hash?: string | null;
}

interface SourceView {
  id: string;
  kind: string;
  uri: string;
  metadata: Record<string, string>;
}

interface AssetView {
  id: string;
  source_id: string;
  kind: string;
  content: {
    uri: string;
    hash: string | null;
    media_type: string | null;
    byte_length: number | null;
  };
  metadata: Record<string, string>;
}

interface RepresentationView {
  id: string;
  owner: ItemRef;
  kind: string;
  content_hash: string;
  content?: unknown;
  provenance: ProvenanceView;
  metadata: Record<string, string>;
}

interface SegmentView {
  id: string;
  asset_id: string;
  locator: {
    byte_range: Span | null;
    character_range: Span | null;
    page_index: number | null;
    time_range_ms: Span | null;
    frame_range: Span | null;
    selectors: Record<string, string>;
  };
  provenance: ProvenanceView | null;
  metadata: Record<string, string>;
}

type RecordView =
  | { record_type: "source"; record: SourceView }
  | { record_type: "asset"; record: AssetView }
  | { record_type: "representation"; record: RepresentationView }
  | { record_type: "segment"; record: SegmentView };

interface PayloadView {
  hash: string;
  media_type: string;
  text: string;
}

// The contract names `CorpusCoreBatchV1` without fixing its TypeScript field
// names. These tests assume the parsed batch exposes the JSONL body as
// `records` (CorpusRecord values in file order) and `payloads` (in file order).
interface BatchView {
  records: RecordView[];
  payloads: PayloadView[];
}

// ---------------------------------------------------------------------------
// Independent reference computations.
// ---------------------------------------------------------------------------

const REVISION = "git:abc123";
const IMPORTED_AT = "2026-10-01T00:00:00.000Z";
const CONTENT_HASH = /^[0-9a-f]{64}$/;
const PRODUCER = "document-search/html-extraction";

function sha256Hex(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function lengthPrefix(bytes: Buffer): Buffer {
  const prefix = Buffer.alloc(8);
  prefix.writeBigUInt64BE(BigInt(bytes.byteLength));
  return prefix;
}

/** corpus-core `derive_identifier`: namespace + ":" + hex(sha256(len_be_u64 ‖ bytes ...)). */
function deriveId(namespace: string, parts: string[]): string {
  const hash = createHash("sha256");
  for (const component of [namespace, ...parts]) {
    const bytes = Buffer.from(component, "utf8");
    hash.update(lengthPrefix(bytes));
    hash.update(bytes);
  }
  return `${namespace}:${hash.digest("hex")}`;
}

function expectedSourceId(documentId: string): string {
  return deriveId("source", ["document-search", documentId]);
}

function expectedAssetId(documentId: string): string {
  return deriveId("asset", [expectedSourceId(documentId)]);
}

function scalarLength(text: string): number {
  return Array.from(text).length;
}

/** Slices `text` by a half-open range expressed in Unicode scalar values. */
function sliceScalars(text: string, range: Span): string {
  return Array.from(text).slice(range.start, range.end).join("");
}

// ---------------------------------------------------------------------------
// Documents built through the real public import path.
// ---------------------------------------------------------------------------

const MARKDOWN_ORIGINAL =
  "# Café 😀\n\nNaïve résumé 😀 **text** with ünïcödé.\n\n- 𝄞 clef item\n\nLater paragraph here.\n";
const PLAIN_ORIGINAL = "First line\nwrapped.\n\nSecond 😀 para.\n";
const HTML_ORIGINAL =
  "<html><head><title>Web page</title></head><body><h1>Heading</h1><p>Body text é.</p></body></html>";

function uploaded(name: string, content: string, mimeType?: string): ExtractedDocument {
  return extractHtmlDocument(
    parseUploadedDocument({ name, content, importedAt: IMPORTED_AT, mimeType }),
  );
}

function markdownDocument(name = "notes.md"): ExtractedDocument {
  return uploaded(name, MARKDOWN_ORIGINAL);
}

function plainDocument(): ExtractedDocument {
  return uploaded("plain.txt", PLAIN_ORIGINAL);
}

function htmlDocument(): ExtractedDocument {
  return uploaded("page.html", HTML_ORIGINAL);
}

/** A document stored before `original` existed: no `original`, no sourceUri. */
function legacyDocument(): ExtractedDocument {
  const document = extractHtmlDocument({
    id: "legacy-1",
    html: "<h2>Legacy</h2><p>Stored before originals were kept ✓.</p>",
    importedAt: "2026-09-01T00:00:00.000Z",
  });
  const legacy = { ...document } as ExtractedDocument & { original?: unknown };
  delete legacy.original;
  return legacy;
}

function urlDocument(): ExtractedDocument {
  return extractHtmlDocument({
    id: "web-1",
    title: "Remote",
    sourceUri: "https://example.test/article",
    html: "<p>Remote paragraph.</p>",
    importedAt: IMPORTED_AT,
  });
}

function sampleDocuments(): ExtractedDocument[] {
  return [markdownDocument(), plainDocument(), htmlDocument(), legacyDocument(), urlDocument()];
}

async function exportText(documents: ExtractedDocument[], revision = REVISION): Promise<string> {
  return serializeCorpusCoreBatch(await createCorpusCoreBatch(documents, revision));
}

function parsed(text: string): BatchView {
  return parseCorpusCoreBatch(text) as unknown as BatchView;
}

/** Resolves typed refs to records using only the parsed JSONL. */
class Reconstruction {
  readonly sources = new Map<string, SourceView>();
  readonly assets = new Map<string, AssetView>();
  readonly representations = new Map<string, RepresentationView>();
  readonly segments = new Map<string, SegmentView>();
  readonly payloads = new Map<string, PayloadView>();

  constructor(batch: BatchView) {
    for (const entry of batch.records) {
      const map = this.mapFor(entry.record_type);
      expect(map.has(entry.record.id)).toBe(false);
      (map as Map<string, unknown>).set(entry.record.id, entry.record);
    }
    for (const payload of batch.payloads) {
      expect(this.payloads.has(payload.hash)).toBe(false);
      this.payloads.set(payload.hash, payload);
    }
  }

  resolve(ref: ItemRef): unknown {
    const record = this.mapFor(ref.record_type).get(ref.id);
    expect(record).toBeDefined();
    return record;
  }

  assetForSource(sourceId: string): AssetView {
    const assets = [...this.assets.values()].filter((asset) => asset.source_id === sourceId);
    expect(assets).toHaveLength(1);
    return assets[0]!;
  }

  representationForAsset(assetId: string): RepresentationView {
    const representations = [...this.representations.values()].filter(
      (representation) =>
        representation.owner.record_type === "asset" && representation.owner.id === assetId,
    );
    expect(representations).toHaveLength(1);
    return representations[0]!;
  }

  segmentsForAsset(assetId: string): SegmentView[] {
    return [...this.segments.values()]
      .filter((segment) => segment.asset_id === assetId)
      .sort(
        (left, right) =>
          Number(left.metadata.paragraph_ordinal) - Number(right.metadata.paragraph_ordinal),
      );
  }

  private mapFor(type: ItemRef["record_type"]): Map<string, unknown> {
    switch (type) {
      case "source":
        return this.sources;
      case "asset":
        return this.assets;
      case "representation":
        return this.representations;
      case "segment":
        return this.segments;
      default:
        throw new Error(`unknown record_type ${String(type)}`);
    }
  }
}

function lines(text: string): string[] {
  expect(text.endsWith("\n")).toBe(true);
  return text.slice(0, -1).split("\n");
}

// ---------------------------------------------------------------------------
// ID derivation (reference implementation vs python3 hashlib).
// ---------------------------------------------------------------------------

describe("corpus-core id derivation", () => {
  test("reference derive matches values computed independently with python3 hashlib", () => {
    // python3: sha256(len_be_u64(ns) ‖ ns ‖ Σ len_be_u64(part) ‖ part), see corpus-core lib.rs
    expect(deriveId("source", ["document-search", "doc-1"])).toBe(
      "source:897e0480130da175e81e61d47f685e98ccb8d0a8f6f986b2f5fd922eb79318bd",
    );
    expect(
      deriveId("asset", [
        "source:897e0480130da175e81e61d47f685e98ccb8d0a8f6f986b2f5fd922eb79318bd",
      ]),
    ).toBe("asset:0a150df026ff1382048f0ea3573e87aafbd3ba51886205ef9b10c76b0e95bb4c");
    expect(deriveId("asset", ["ab", "c"])).toBe(
      "asset:45a85a3e979eeb83d34f827f1fe25753170db2979f65040d6edd7a476ceb1dcf",
    );
    expect(deriveId("asset", ["a", "bc"])).toBe(
      "asset:c0cce71fd45c094f15a090f2fa82549183212c22619bf5a51efa4bc55bfbf804",
    );
    expect(deriveId("asset", ["ab", "c"])).not.toBe(deriveId("asset", ["a", "bc"]));
  });

  test("export derives source and asset ids exactly like corpus-core", async () => {
    const document = extractHtmlDocument({
      id: "doc-1",
      html: "<p>Fixed identity.</p>",
      importedAt: IMPORTED_AT,
    });
    const batch = parsed(await exportText([document]));
    const source = batch.records.find((entry) => entry.record_type === "source");
    const asset = batch.records.find((entry) => entry.record_type === "asset");

    expect(source?.record.id).toBe(
      "source:897e0480130da175e81e61d47f685e98ccb8d0a8f6f986b2f5fd922eb79318bd",
    );
    expect(asset?.record.id).toBe(
      "asset:0a150df026ff1382048f0ea3573e87aafbd3ba51886205ef9b10c76b0e95bb4c",
    );
  });

  test("ids are length-delimited: document ids that only differ in boundaries do not alias", async () => {
    // The source id is source.derive(["document-search", id]); naive concatenation
    // of "document-search" + id would alias "document-searchab"/"c" style inputs.
    const first = extractHtmlDocument({ id: "ab", html: "<p>One.</p>", importedAt: IMPORTED_AT });
    const second = extractHtmlDocument({ id: "a", html: "<p>Two.</p>", importedAt: IMPORTED_AT });
    const batch = parsed(await exportText([first, second]));
    const sourceIds = batch.records
      .filter((entry) => entry.record_type === "source")
      .map((entry) => entry.record.id);

    expect(sourceIds).toEqual([expectedSourceId("a"), expectedSourceId("ab")]);
    expect(new Set(sourceIds).size).toBe(2);
  });

  test("every record id is namespaced and every hash is a canonical ContentHash", async () => {
    const batch = parsed(await exportText(sampleDocuments()));
    for (const entry of batch.records) {
      expect(entry.record.id).toMatch(new RegExp(`^${entry.record_type}:[0-9a-f]{64}$`));
      if (entry.record_type === "asset") {
        expect(entry.record.content.hash).toMatch(CONTENT_HASH);
        expect(entry.record.content.hash).not.toContain("sha256:");
      }
      if (entry.record_type === "representation") {
        expect(entry.record.content_hash).toMatch(CONTENT_HASH);
      }
    }
    for (const payload of batch.payloads) {
      expect(payload.hash).toMatch(CONTENT_HASH);
    }
  });
});

// ---------------------------------------------------------------------------
// Original bytes retained at import.
// ---------------------------------------------------------------------------

describe("original imported bytes", () => {
  test("parseUploadedDocument retains the original and extractHtmlDocument carries it", () => {
    const input = parseUploadedDocument({
      name: "notes.md",
      content: MARKDOWN_ORIGINAL,
      importedAt: IMPORTED_AT,
    }) as ReturnType<typeof parseUploadedDocument> & { original?: unknown };
    expect(input.original).toEqual({ content: MARKDOWN_ORIGINAL, mediaType: "text/markdown" });

    const document = extractHtmlDocument(input) as ExtractedDocument & { original?: unknown };
    expect(document.original).toEqual({ content: MARKDOWN_ORIGINAL, mediaType: "text/markdown" });

    const plain = plainDocument() as ExtractedDocument & { original?: unknown };
    expect(plain.original).toEqual({ content: PLAIN_ORIGINAL, mediaType: "text/plain" });
    const html = htmlDocument() as ExtractedDocument & { original?: unknown };
    expect(html.original).toEqual({ content: HTML_ORIGINAL, mediaType: "text/html" });
  });

  test.each([
    ["markdown", markdownDocument, MARKDOWN_ORIGINAL, "text/markdown", "text"],
    ["plain text", plainDocument, PLAIN_ORIGINAL, "text/plain", "text"],
    ["html", htmlDocument, HTML_ORIGINAL, "text/html", "web_page"],
  ] as const)(
    "%s asset content describes the original bytes",
    async (_label, build, original, mediaType, kind) => {
      const document = build();
      const view = new Reconstruction(parsed(await exportText([document])));
      const asset = view.assets.get(expectedAssetId(document.id));

      expect(asset).toBeDefined();
      expect(asset!.kind).toBe(kind);
      expect(asset!.metadata.content_basis).toBe("original");
      expect(asset!.content.hash).toBe(sha256Hex(original));
      expect(asset!.content.byte_length).toBe(Buffer.byteLength(original, "utf8"));
      // Guard: Markdown/plain-text originals differ from the normalized HTML.
      if (mediaType !== "text/html") {
        expect(asset!.content.hash).not.toBe(sha256Hex(document.html));
      }
      expect(asset!.content.hash).not.toBe(sha256Hex(document.text));
      expect(asset!.content.media_type?.split(";")[0]?.trim()).toBe(mediaType);
      expect(typeof asset!.content.uri).toBe("string");
      expect(asset!.content.uri.length).toBeGreaterThan(0);

      // The original text is exported as a payload keyed by its content hash.
      expect(view.payloads.get(sha256Hex(original))?.text).toBe(original);
    },
  );

  test("a legacy document without original exports with a normalized_html basis", async () => {
    const document = legacyDocument();
    const view = new Reconstruction(parsed(await exportText([document])));
    const source = view.sources.get(expectedSourceId("legacy-1"));
    const asset = view.assets.get(expectedAssetId("legacy-1"));

    expect(source?.kind).toBe("inline");
    expect(source?.uri).toBe("document-search:document/legacy-1");
    expect(asset?.kind).toBe("web_page");
    expect(asset?.metadata.content_basis).toBe("normalized_html");
    expect(asset?.content.hash).toBe(sha256Hex(document.html));
    expect(asset?.content.byte_length).toBe(Buffer.byteLength(document.html, "utf8"));
    expect(asset?.content.media_type?.split(";")[0]?.trim()).toBe("text/html");
  });

  test("source records map kind, uri and metadata", async () => {
    const markdown = markdownDocument();
    const web = urlDocument();
    const view = new Reconstruction(parsed(await exportText([markdown, web])));

    expect(view.sources.get(expectedSourceId(markdown.id))).toEqual({
      id: expectedSourceId(markdown.id),
      kind: "inline",
      uri: "notes.md",
      metadata: { title: "notes", imported_at: IMPORTED_AT },
    });
    expect(view.sources.get(expectedSourceId("web-1"))).toEqual({
      id: expectedSourceId("web-1"),
      kind: "url",
      uri: "https://example.test/article",
      metadata: { title: "Remote", imported_at: IMPORTED_AT },
    });
  });
});

// ---------------------------------------------------------------------------
// Reconstruction and provenance.
// ---------------------------------------------------------------------------

describe("reconstruction from parsed JSONL", () => {
  test("source → asset → segment → representation is reconstructable from the text alone", async () => {
    const documents = sampleDocuments();
    const text = await exportText(documents);
    const view = new Reconstruction(parsed(text));

    expect(view.sources.size).toBe(documents.length);
    expect(view.assets.size).toBe(documents.length);
    expect(view.representations.size).toBe(documents.length);
    expect(view.segments.size).toBe(
      documents.reduce((total, document) => total + document.paragraphs.length, 0),
    );

    for (const document of documents) {
      const sourceId = expectedSourceId(document.id);
      expect(view.sources.has(sourceId)).toBe(true);

      const asset = view.assetForSource(sourceId);
      expect(asset.id).toBe(expectedAssetId(document.id));
      expect(view.resolve({ record_type: "source", id: asset.source_id })).toBeDefined();

      const representation = view.representationForAsset(asset.id);
      expect(representation.kind).toBe("extracted_text");
      expect(representation.content_hash).toBe(sha256Hex(document.text));
      expect(view.payloads.get(representation.content_hash)).toEqual({
        hash: sha256Hex(document.text),
        media_type: "text/plain; charset=utf-8",
        text: document.text,
      });

      const segments = view.segmentsForAsset(asset.id);
      expect(segments).toHaveLength(document.paragraphs.length);
      segments.forEach((segment, ordinal) => {
        const representationId = segment.locator.selectors.representation_id!;
        expect(representationId).toBe(representation.id);
        const resolved = view.resolve({
          record_type: "representation",
          id: representationId,
        }) as RepresentationView;
        const payload = view.payloads.get(resolved.content_hash)!;
        expect(sliceScalars(payload.text, segment.locator.character_range!)).toBe(
          document.paragraphs[ordinal]!.text,
        );
        for (const input of segment.provenance!.inputs) {
          expect(view.resolve(input)).toBeDefined();
        }
      });
    }
  });

  test("representation and segments carry explicit parser provenance", async () => {
    const document = markdownDocument();
    const view = new Reconstruction(parsed(await exportText([document])));
    const assetId = expectedAssetId(document.id);
    const representation = view.representationForAsset(assetId);

    expect(representation.owner).toEqual({ record_type: "asset", id: assetId });
    expect(representation.provenance).toEqual({
      operation: "extract_text",
      producer: PRODUCER,
      producer_version: REVISION,
      inputs: [{ record_type: "asset", id: assetId }],
      parameters_hash: null,
    });

    const segments = view.segmentsForAsset(assetId);
    expect(segments.length).toBeGreaterThan(0);
    for (const segment of segments) {
      expect(segment.provenance?.operation).toBe("segment_paragraphs");
      expect(segment.provenance?.producer).toBe(PRODUCER);
      expect(segment.provenance?.producer_version).toBe(REVISION);
      expect(segment.provenance?.inputs).toEqual([
        { record_type: "representation", id: representation.id },
      ]);
    }
  });

  test("segment locators use Unicode scalar character ranges and paragraph metadata", async () => {
    const document = markdownDocument();
    // Guard: the fixture really exercises non-BMP text before later paragraphs.
    expect(document.text.length).not.toBe(scalarLength(document.text));
    expect(document.paragraphs.length).toBeGreaterThanOrEqual(4);

    const view = new Reconstruction(parsed(await exportText([document])));
    const assetId = expectedAssetId(document.id);
    const representation = view.representationForAsset(assetId);
    const segments = view.segmentsForAsset(assetId);

    let searchFrom = 0;
    segments.forEach((segment, ordinal) => {
      const paragraph = document.paragraphs[ordinal]!;
      const utf16Start = document.text.indexOf(paragraph.text, searchFrom);
      expect(utf16Start).toBeGreaterThanOrEqual(0);
      searchFrom = utf16Start + paragraph.text.length;
      const start = scalarLength(document.text.slice(0, utf16Start));
      const expectedRange = { start, end: start + scalarLength(paragraph.text) };

      expect(segment.asset_id).toBe(assetId);
      expect(segment.locator).toEqual({
        byte_range: null,
        character_range: expectedRange,
        page_index: null,
        time_range_ms: null,
        frame_range: null,
        selectors: { character_unit: "unicode_scalar", representation_id: representation.id },
      });
      expect(sliceScalars(document.text, segment.locator.character_range!)).toBe(paragraph.text);

      expect(segment.metadata.paragraph_ordinal).toBe(String(paragraph.ordinal));
      expect(JSON.parse(segment.metadata.heading_path!)).toEqual(paragraph.headingPath);
      if (paragraph.sourceSelector) {
        expect(segment.metadata.source_selector).toBe(paragraph.sourceSelector);
      } else {
        expect(segment.metadata.source_selector).toBeUndefined();
      }
    });

    // The later paragraph's scalar offset differs from its UTF-16 offset.
    const last = segments.at(-1)!;
    const lastParagraph = document.paragraphs.at(-1)!;
    expect(last.locator.character_range!.start).not.toBe(
      document.text.lastIndexOf(lastParagraph.text),
    );
  });

  test("exact duplicate originals share a content hash but keep distinct record identities", async () => {
    const first = markdownDocument("first.md");
    const second = markdownDocument("second.md");
    expect(first.id).not.toBe(second.id);

    const batch = parsed(await exportText([first, second]));
    const view = new Reconstruction(batch);
    const firstAsset = view.assets.get(expectedAssetId(first.id))!;
    const secondAsset = view.assets.get(expectedAssetId(second.id))!;

    expect(firstAsset.content.hash).toBe(sha256Hex(MARKDOWN_ORIGINAL));
    expect(secondAsset.content.hash).toBe(firstAsset.content.hash);
    expect(expectedSourceId(first.id)).not.toBe(expectedSourceId(second.id));
    expect(view.sources.has(expectedSourceId(first.id))).toBe(true);
    expect(view.sources.has(expectedSourceId(second.id))).toBe(true);
    expect(firstAsset.id).not.toBe(secondAsset.id);
    expect(firstAsset.source_id).toBe(expectedSourceId(first.id));
    expect(secondAsset.source_id).toBe(expectedSourceId(second.id));

    // Payloads are deduplicated by content hash.
    const hashes = batch.payloads.map((payload) => payload.hash);
    expect(new Set(hashes).size).toBe(hashes.length);
    expect(hashes.filter((hash) => hash === sha256Hex(MARKDOWN_ORIGINAL))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Determinism, ordering and serialization.
// ---------------------------------------------------------------------------

describe("deterministic serialization", () => {
  test("header line, trailing newline and line shapes follow the contract", async () => {
    const text = await exportText(sampleDocuments());
    const [header, ...body] = lines(text);

    expect(header).toBe(
      '{"schema":"moenarch_corpus_core_batch","schema_version":1,"producer":{"name":"document-search","revision":"git:abc123"}}',
    );
    expect(body.length).toBeGreaterThan(0);
    let seenPayload = false;
    for (const line of body) {
      const value = JSON.parse(line) as Record<string, unknown>;
      const keys = Object.keys(value);
      expect(keys).toHaveLength(1);
      if (keys[0] === "payload") {
        seenPayload = true;
        expect(Object.keys(value.payload as object).sort()).toEqual(["hash", "media_type", "text"]);
      } else {
        expect(keys[0]).toBe("record");
        // Payloads follow all records.
        expect(seenPayload).toBe(false);
      }
    }
    expect(seenPayload).toBe(true);
  });

  test("output is byte-identical across runs and input orders", async () => {
    const documents = sampleDocuments();
    const first = await exportText(documents);
    const second = await exportText(sampleDocuments());
    const reversed = await exportText([...sampleDocuments()].reverse());
    const shuffled = sampleDocuments();
    const rotated = [shuffled[2]!, shuffled[4]!, shuffled[0]!, shuffled[3]!, shuffled[1]!];

    expect(second).toBe(first);
    expect(reversed).toBe(first);
    expect(await exportText(rotated)).toBe(first);
    // Serializing the parsed batch reproduces the exact text.
    expect(serializeCorpusCoreBatch(parseCorpusCoreBatch(first))).toBe(first);
  });

  test("records are ordered by document id, then source, asset, representation, segments", async () => {
    const documents = sampleDocuments();
    const batch = parsed(await exportText([...documents].reverse()));
    const sortedIds = documents.map((document) => document.id).sort();
    const byId = new Map(documents.map((document) => [document.id, document]));

    const expectedTypes: string[] = [];
    const expectedSourceOrder: string[] = [];
    for (const id of sortedIds) {
      expectedSourceOrder.push(expectedSourceId(id));
      expectedTypes.push("source", "asset", "representation");
      for (let index = 0; index < byId.get(id)!.paragraphs.length; index += 1) {
        expectedTypes.push("segment");
      }
    }

    expect(batch.records.map((entry) => entry.record_type)).toEqual(expectedTypes);
    expect(
      batch.records
        .filter((entry) => entry.record_type === "source")
        .map((entry) => entry.record.id),
    ).toEqual(expectedSourceOrder);

    // Segments of each asset appear in ordinal order.
    const ordinalsByAsset = new Map<string, number[]>();
    for (const entry of batch.records) {
      if (entry.record_type === "segment") {
        const list = ordinalsByAsset.get(entry.record.asset_id) ?? [];
        list.push(Number(entry.record.metadata.paragraph_ordinal));
        ordinalsByAsset.set(entry.record.asset_id, list);
      }
    }
    for (const ordinals of ordinalsByAsset.values()) {
      expect(ordinals).toEqual([...ordinals].sort((left, right) => left - right));
    }

    const payloadHashes = batch.payloads.map((payload) => payload.hash);
    expect(payloadHashes).toEqual([...payloadHashes].sort());
    for (const payload of batch.payloads) {
      expect(payload.hash).toBe(sha256Hex(payload.text));
    }
  });
});

// ---------------------------------------------------------------------------
// Fail-closed behaviour.
// ---------------------------------------------------------------------------

describe("fail closed", () => {
  test("an empty producer revision is rejected", async () => {
    await expect(createCorpusCoreBatch([markdownDocument()], "")).rejects.toThrow(/revision/i);
    await expect(createCorpusCoreBatch([markdownDocument()], "   ")).rejects.toThrow(/revision/i);
  });

  test("a paragraph that cannot be located inside the text is rejected", async () => {
    const document = plainDocument();
    document.paragraphs[1] = { ...document.paragraphs[1]!, text: "Drifted text." };
    await expect(createCorpusCoreBatch([document], REVISION)).rejects.toThrow();
  });

  test("parseCorpusCoreBatch rejects wrong schema, version and malformed lines", async () => {
    const valid = await exportText([plainDocument()]);
    const [header, ...body] = lines(valid);
    const rebuild = (first: string, rest: string[] = body) => `${[first, ...rest].join("\n")}\n`;

    expect(() => parseCorpusCoreBatch(valid)).not.toThrow();
    expect(() => parseCorpusCoreBatch("")).toThrow();
    expect(() =>
      parseCorpusCoreBatch(rebuild(header!.replace("moenarch_corpus_core_batch", "other_batch"))),
    ).toThrow();
    expect(() =>
      parseCorpusCoreBatch(rebuild(header!.replace('"schema_version":1', '"schema_version":2'))),
    ).toThrow();
    expect(() => parseCorpusCoreBatch(rebuild(header!, [...body, "{not json"]))).toThrow();
    expect(() => parseCorpusCoreBatch(rebuild(header!, [...body, '{"unexpected":{}}']))).toThrow();
    expect(() => parseCorpusCoreBatch(rebuild(body[0]!, body.slice(1)))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Committed fixture, consumed without browser APIs.
// ---------------------------------------------------------------------------

describe("committed JSONL fixture", () => {
  const fixtureText = readFileSync(
    new URL("./fixtures/corpus-core-batch.jsonl", import.meta.url),
    "utf8",
  );

  test("fixture is internally consistent with corpus-core derivation (sanity check)", () => {
    const sourceId = expectedSourceId("fixture-1");
    expect(fixtureText).toContain(`"id":"${sourceId}"`);
    expect(fixtureText).toContain(`"id":"${deriveId("asset", [sourceId])}"`);
    expect(fixtureText).toContain(sha256Hex("Alpha 😀 café one.\n\nBeta two."));
    expect(fixtureText).toContain(sha256Hex("Alpha 😀 café\none.\n\nBeta two.\n"));
  });

  test("fixture parses with no IndexedDB or window and reconstructs its records", () => {
    const globals = globalThis as Record<string, unknown>;
    const saved = new Map<string, PropertyDescriptor | undefined>();
    for (const name of ["indexedDB", "window", "document", "localStorage"]) {
      saved.set(name, Object.getOwnPropertyDescriptor(globals, name));
      Object.defineProperty(globals, name, {
        configurable: true,
        get() {
          throw new Error(`browser API ${name} must not be used by parseCorpusCoreBatch`);
        },
      });
    }

    let batch: BatchView;
    try {
      batch = parsed(fixtureText);
    } finally {
      for (const [name, descriptor] of saved) {
        if (descriptor) {
          Object.defineProperty(globals, name, descriptor);
        } else {
          delete globals[name];
        }
      }
    }

    const view = new Reconstruction(batch);
    expect(batch.records.map((entry) => entry.record_type)).toEqual([
      "source",
      "asset",
      "representation",
      "segment",
      "segment",
    ]);
    expect(batch.payloads).toHaveLength(2);

    const sourceId = expectedSourceId("fixture-1");
    const asset = view.assetForSource(sourceId);
    expect(asset.metadata.content_basis).toBe("original");
    expect(view.payloads.get(asset.content.hash!)?.text).toBe("Alpha 😀 café\none.\n\nBeta two.\n");

    const representation = view.representationForAsset(asset.id);
    expect(representation.provenance.producer).toBe(PRODUCER);
    expect(representation.provenance.producer_version).toBe("git:fixture");
    const extracted = view.payloads.get(representation.content_hash)!.text;

    const segments = view.segmentsForAsset(asset.id);
    expect(
      segments.map((segment) => sliceScalars(extracted, segment.locator.character_range!)),
    ).toEqual(["Alpha 😀 café one.", "Beta two."]);
    for (const segment of segments) {
      expect(segment.provenance?.inputs).toEqual([
        { record_type: "representation", id: representation.id },
      ]);
    }

    // Re-serializing the parsed fixture preserves its header and record content.
    const reserialized = lines(serializeCorpusCoreBatch(parseCorpusCoreBatch(fixtureText)));
    const original = lines(fixtureText);
    expect(reserialized[0]).toBe(original[0]);
    expect(reserialized.map((line) => JSON.parse(line))).toEqual(
      original.map((line) => JSON.parse(line)),
    );
  });
});

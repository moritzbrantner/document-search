// Deterministic export of Document Search corpora as `moenarch-corpus-core` records
// (moenarch-foundation `crates/corpus/corpus-core`, `docs/specs/corpus-core-contract.md`).
// The JSON shapes mirror corpus-core's serde output: snake_case fields, tagged
// `CorpusRecord`/`CorpusItemRef` enums, string-to-string metadata and bare
// lowercase SHA-256 content hashes. Typed ids use corpus-core's length-delimited
// `derive`, so a Rust consumer recomputes the same identities.
import { denseHeadingPath } from "../domain/headingPath";
import type { ExtractedDocument } from "../domain/types";

export const CORPUS_CORE_BATCH_SCHEMA = "moenarch_corpus_core_batch";
export const CORPUS_CORE_BATCH_SCHEMA_VERSION = 1;

const PRODUCER_NAME = "document-search";
const EXTRACTION_PRODUCER = "document-search/html-extraction";
/** Separator `extractHtmlDocument` places between paragraphs in `document.text`. */
const PARAGRAPH_SEPARATOR = "\n\n";
const TEXT_PAYLOAD_MEDIA_TYPE = "text/plain; charset=utf-8";

export type CorpusRecordType = "source" | "asset" | "segment" | "representation";
export type CorpusMetadata = Record<string, string>;

export interface CorpusItemRef {
  record_type: CorpusRecordType;
  id: string;
}

export interface CorpusSpan {
  start: number;
  end: number;
}

export interface CorpusProvenance {
  operation: string;
  producer: string;
  producer_version: string | null;
  inputs: CorpusItemRef[];
  parameters_hash: string | null;
}

export interface CorpusContentRef {
  uri: string;
  hash: string | null;
  media_type: string | null;
  byte_length: number | null;
}

export interface CorpusSource {
  id: string;
  kind: string;
  uri: string;
  metadata: CorpusMetadata;
}

export interface CorpusAsset {
  id: string;
  source_id: string;
  kind: string;
  content: CorpusContentRef;
  metadata: CorpusMetadata;
}

export interface CorpusSegmentLocator {
  byte_range: CorpusSpan | null;
  character_range: CorpusSpan | null;
  page_index: number | null;
  time_range_ms: CorpusSpan | null;
  frame_range: CorpusSpan | null;
  selectors: CorpusMetadata;
}

export interface CorpusSegment {
  id: string;
  asset_id: string;
  locator: CorpusSegmentLocator;
  provenance: CorpusProvenance | null;
  metadata: CorpusMetadata;
}

export interface CorpusRepresentation {
  id: string;
  owner: CorpusItemRef;
  kind: string;
  content_hash: string;
  content: CorpusContentRef | null;
  provenance: CorpusProvenance;
  metadata: CorpusMetadata;
}

export type CorpusRecord =
  | { record_type: "source"; record: CorpusSource }
  | { record_type: "asset"; record: CorpusAsset }
  | { record_type: "segment"; record: CorpusSegment }
  | { record_type: "representation"; record: CorpusRepresentation };

/** Content-addressed text payload referenced by an asset or representation hash. */
export interface CorpusPayload {
  hash: string;
  media_type: string;
  text: string;
}

export interface CorpusCoreBatchV1 {
  schema: typeof CORPUS_CORE_BATCH_SCHEMA;
  schemaVersion: typeof CORPUS_CORE_BATCH_SCHEMA_VERSION;
  producer: { name: string; revision: string };
  /** Records in file order. */
  records: CorpusRecord[];
  /** Payloads in file order (sorted by hash when produced by this module). */
  payloads: CorpusPayload[];
}

/**
 * One explicit web capture (filesystem corpus `captureUrls`). Its HTTP/capture provenance goes
 * to the Source and Asset records; the extracted text stays a derived Representation.
 */
export interface WebCaptureExportInput {
  captureId: string;
  /** The capture's extracted document, or null when no text was extracted. */
  documentId: string | null;
  requestedUrl: string;
  finalUrl: string;
  retrievedAt: string;
  status: number;
  redirectChain: readonly {
    url: string;
    status: number;
    location: string | null;
    retrievedAt: string;
  }[];
  /** Raw Content-Type header of the final response. */
  contentType: string | null;
  contentEncoding: string | null;
  /** SHA-256 of the exact final entity bytes. */
  payloadSha256: string;
  payloadByteLength: number;
  /** The exact payload as text when the bytes are lossless UTF-8, else null (not exported). */
  payloadText: string | null;
  warcPath: string;
  warcSha256: string;
  warcRecordId: string;
  producer: string;
  producerVersion: string;
  extractor: string | null;
}

export interface CorpusCoreBatchOptions {
  webCaptures?: readonly WebCaptureExportInput[];
}

const textEncoder = new TextEncoder();

export async function createCorpusCoreBatch(
  documents: ExtractedDocument[],
  producerRevision: string,
  options: CorpusCoreBatchOptions = {},
): Promise<CorpusCoreBatchV1> {
  if (!producerRevision.trim()) {
    throw new Error("A producer revision is required for corpus-core export.");
  }

  const records: CorpusRecord[] = [];
  const payloads = new Map<string, CorpusPayload>();
  const addPayload = (payload: CorpusPayload) => {
    if (!payloads.has(payload.hash)) payloads.set(payload.hash, payload);
  };

  const captures = [...(options.webCaptures ?? [])].sort((left, right) =>
    compareCodeUnits(left.captureId, right.captureId),
  );
  const captureByDocument = new Map(
    captures.flatMap((capture) =>
      capture.documentId === null ? [] : [[capture.documentId, capture] as const],
    ),
  );

  const ordered = [...documents].sort((left, right) => compareCodeUnits(left.id, right.id));
  for (const document of ordered) {
    const sourceId = await deriveCorpusId("source", [PRODUCER_NAME, document.id]);
    const assetId = await deriveCorpusId("asset", [sourceId]);
    const assetRef: CorpusItemRef = { record_type: "asset", id: assetId };
    const uri = document.sourceUri ?? `document-search:document/${document.id}`;
    const capture = captureByDocument.get(document.id);

    if (capture) {
      records.push(...captureSourceAndAsset(capture, sourceId, assetId, document.title));
      if (capture.payloadText !== null) addPayload(capturePayload(capture));
    } else {
      records.push({
        record_type: "source",
        record: {
          id: sourceId,
          kind: /^https?:\/\//i.test(document.sourceUri ?? "") ? "url" : "inline",
          uri,
          metadata: sortedMetadata({ title: document.title, imported_at: document.importedAt }),
        },
      });

      const original = document.original;
      const assetText = original ? original.content : document.html;
      const assetMediaType = original ? original.mediaType : "text/html";
      const assetHash = await sha256Hex(assetText);
      records.push({
        record_type: "asset",
        record: {
          id: assetId,
          source_id: sourceId,
          kind: assetMediaType === "text/html" ? "web_page" : "text",
          content: {
            uri,
            hash: assetHash,
            media_type: `${assetMediaType}; charset=utf-8`,
            byte_length: utf8Length(assetText),
          },
          metadata: { content_basis: original ? "original" : "normalized_html" },
        },
      });
      if (original) {
        addPayload({
          hash: assetHash,
          media_type: `${original.mediaType}; charset=utf-8`,
          text: original.content,
        });
      }
    }

    const textHash = await sha256Hex(document.text);
    const representationId = await deriveCorpusId("representation", [assetId, "extracted_text"]);
    const representationRef: CorpusItemRef = {
      record_type: "representation",
      id: representationId,
    };
    records.push({
      record_type: "representation",
      record: {
        id: representationId,
        owner: assetRef,
        kind: "extracted_text",
        content_hash: textHash,
        content: null,
        provenance: provenance("extract_text", producerRevision, [assetRef]),
        metadata: capture?.extractor ? { extractor: capture.extractor } : {},
      },
    });
    addPayload({ hash: textHash, media_type: TEXT_PAYLOAD_MEDIA_TYPE, text: document.text });

    // Ranges are only trustworthy when the ordered paragraphs, joined by the extraction
    // separator, reproduce the representation text exactly (a drifted snapshot could
    // otherwise still match a substring and point at part of a paragraph).
    const paragraphs = [...document.paragraphs].sort((left, right) => left.ordinal - right.ordinal);
    if (paragraphs.map((paragraph) => paragraph.text).join(PARAGRAPH_SEPARATOR) !== document.text) {
      throw new Error(
        `Paragraphs of document ${document.id} do not reconstruct its extracted text; refusing to emit ambiguous provenance.`,
      );
    }
    let start = 0;
    for (const paragraph of paragraphs) {
      const end = start + scalarLength(paragraph.text);
      const metadata: CorpusMetadata = {
        heading_path: JSON.stringify(denseHeadingPath(paragraph.headingPath)),
        paragraph_ordinal: String(paragraph.ordinal),
      };
      if (paragraph.sourceSelector) metadata.source_selector = paragraph.sourceSelector;

      records.push({
        record_type: "segment",
        record: {
          id: await deriveCorpusId("segment", [representationId, String(paragraph.ordinal)]),
          asset_id: assetId,
          locator: {
            byte_range: null,
            character_range: { start, end },
            page_index: null,
            time_range_ms: null,
            frame_range: null,
            selectors: { character_unit: "unicode_scalar", representation_id: representationId },
          },
          provenance: provenance("segment_paragraphs", producerRevision, [representationRef]),
          metadata: sortedMetadata(metadata),
        },
      });
      start = end + scalarLength(PARAGRAPH_SEPARATOR);
    }
  }

  // Captures without extracted text still export their exact HTTP payload as Source + Asset.
  for (const capture of captures) {
    if (capture.documentId !== null) continue;
    const sourceId = await deriveCorpusId("source", [PRODUCER_NAME, capture.captureId]);
    const assetId = await deriveCorpusId("asset", [sourceId]);
    records.push(...captureSourceAndAsset(capture, sourceId, assetId, null));
    if (capture.payloadText !== null) addPayload(capturePayload(capture));
  }

  return {
    schema: CORPUS_CORE_BATCH_SCHEMA,
    schemaVersion: CORPUS_CORE_BATCH_SCHEMA_VERSION,
    producer: { name: PRODUCER_NAME, revision: producerRevision },
    records,
    payloads: [...payloads.values()].sort((left, right) => compareCodeUnits(left.hash, right.hash)),
  };
}

/** Serializes a batch as JSON Lines: a header line, record lines, then payload lines. */
export function serializeCorpusCoreBatch(batch: CorpusCoreBatchV1): string {
  const lines = [
    JSON.stringify({
      schema: batch.schema,
      schema_version: batch.schemaVersion,
      producer: { name: batch.producer.name, revision: batch.producer.revision },
    }),
    ...batch.records.map((record) => JSON.stringify({ record })),
    ...batch.payloads.map((payload) => JSON.stringify({ payload })),
  ];
  return `${lines.join("\n")}\n`;
}

/** Parses a JSON Lines batch without browser APIs; fails closed on anything unexpected. */
export function parseCorpusCoreBatch(text: string): CorpusCoreBatchV1 {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0) throw new Error("Corpus-core batch is empty.");

  const header = parseLine(lines[0]!, 1);
  if (header.schema !== CORPUS_CORE_BATCH_SCHEMA) {
    throw new Error(`Unsupported corpus-core batch schema: ${String(header.schema)}`);
  }
  if (header.schema_version !== CORPUS_CORE_BATCH_SCHEMA_VERSION) {
    throw new Error(`Unsupported corpus-core batch version: ${String(header.schema_version)}`);
  }
  const producer = header.producer as Record<string, unknown> | undefined;
  if (
    !isObject(producer) ||
    typeof producer.name !== "string" ||
    typeof producer.revision !== "string"
  ) {
    throw new Error("Corpus-core batch header has no valid producer.");
  }

  const records: CorpusRecord[] = [];
  const payloads: CorpusPayload[] = [];
  lines.slice(1).forEach((line, index) => {
    const lineNumber = index + 2;
    const value = parseLine(line, lineNumber);
    const keys = Object.keys(value);
    if (keys.length !== 1)
      throw new Error(`Line ${lineNumber} must hold exactly one record or payload.`);
    if (keys[0] === "record") {
      const record = value.record;
      if (
        !isObject(record) ||
        !["source", "asset", "segment", "representation"].includes(record.record_type as string) ||
        !isObject(record.record) ||
        typeof record.record.id !== "string"
      ) {
        throw new Error(`Line ${lineNumber} is not a corpus-core record.`);
      }
      records.push(record as unknown as CorpusRecord);
    } else if (keys[0] === "payload") {
      const payload = value.payload;
      if (
        !isObject(payload) ||
        typeof payload.hash !== "string" ||
        !/^[0-9a-f]{64}$/.test(payload.hash) ||
        typeof payload.media_type !== "string" ||
        typeof payload.text !== "string"
      ) {
        throw new Error(`Line ${lineNumber} is not a corpus-core payload.`);
      }
      payloads.push(payload as unknown as CorpusPayload);
    } else {
      throw new Error(`Line ${lineNumber} must hold a record or a payload.`);
    }
  });

  return {
    schema: CORPUS_CORE_BATCH_SCHEMA,
    schemaVersion: CORPUS_CORE_BATCH_SCHEMA_VERSION,
    producer: { name: producer.name, revision: producer.revision },
    records,
    payloads,
  };
}

/** corpus-core `derive`: namespace + ":" + hex(sha256(len_be_u64(part) ‖ part …)) over namespace and parts. */
export async function deriveCorpusId(
  namespace: CorpusRecordType,
  parts: readonly string[],
): Promise<string> {
  const components = [namespace, ...parts].map((component) => textEncoder.encode(component));
  const total = components.reduce((sum, bytes) => sum + 8 + bytes.byteLength, 0);
  const buffer = new Uint8Array(total);
  const view = new DataView(buffer.buffer);
  let offset = 0;
  for (const bytes of components) {
    view.setBigUint64(offset, BigInt(bytes.byteLength), false);
    buffer.set(bytes, offset + 8);
    offset += 8 + bytes.byteLength;
  }
  return `${namespace}:${await digestHex(buffer)}`;
}

/**
 * Source and Asset records of one capture. Each capture keeps its own Source (requested URL and
 * retrieval) even when another capture holds identical payload bytes: the assets then simply
 * share one content hash.
 */
function captureSourceAndAsset(
  capture: WebCaptureExportInput,
  sourceId: string,
  assetId: string,
  title: string | null,
): CorpusRecord[] {
  const sourceMetadata: CorpusMetadata = {
    capture_id: capture.captureId,
    capture_producer: capture.producer,
    capture_producer_version: capture.producerVersion,
    final_url: capture.finalUrl,
    http_status: String(capture.status),
    imported_at: capture.retrievedAt,
    redirect_chain: JSON.stringify(capture.redirectChain),
    requested_url: capture.requestedUrl,
    retrieved_at: capture.retrievedAt,
  };
  if (title !== null) sourceMetadata.title = title;
  const assetMetadata: CorpusMetadata = {
    content_basis: "http_payload",
    warc_file: capture.warcPath,
    warc_file_sha256: capture.warcSha256,
    warc_record_id: capture.warcRecordId,
  };
  if (capture.contentEncoding !== null) assetMetadata.content_encoding = capture.contentEncoding;
  const mediaType = capture.contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return [
    {
      record_type: "source",
      record: {
        id: sourceId,
        kind: "url",
        uri: capture.requestedUrl,
        metadata: sortedMetadata(sourceMetadata),
      },
    },
    {
      record_type: "asset",
      record: {
        id: assetId,
        source_id: sourceId,
        kind:
          mediaType === "text/html" || mediaType === "application/xhtml+xml"
            ? "web_page"
            : "web_resource",
        content: {
          uri: capture.finalUrl,
          hash: capture.payloadSha256,
          media_type: capture.contentType,
          byte_length: capture.payloadByteLength,
        },
        metadata: sortedMetadata(assetMetadata),
      },
    },
  ];
}

function capturePayload(capture: WebCaptureExportInput): CorpusPayload {
  return {
    hash: capture.payloadSha256,
    media_type: capture.contentType ?? "application/octet-stream",
    text: capture.payloadText ?? "",
  };
}

function provenance(
  operation: string,
  revision: string,
  inputs: CorpusItemRef[],
): CorpusProvenance {
  return {
    operation,
    producer: EXTRACTION_PRODUCER,
    producer_version: revision,
    inputs,
    parameters_hash: null,
  };
}

function sortedMetadata(metadata: CorpusMetadata): CorpusMetadata {
  // corpus-core metadata is a BTreeMap: serialize keys in sorted order.
  return Object.fromEntries(
    Object.entries(metadata).sort(([left], [right]) => compareCodeUnits(left, right)),
  );
}

function parseLine(line: string, lineNumber: number): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error(`Line ${lineNumber} is not valid JSON.`);
  }
  if (!isObject(value)) throw new Error(`Line ${lineNumber} is not a JSON object.`);
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function scalarLength(text: string): number {
  // Unicode scalar values: string iteration yields whole code points.
  return Array.from(text).length;
}

function utf8Length(value: string): number {
  return textEncoder.encode(value).byteLength;
}

async function sha256Hex(value: string): Promise<string> {
  return digestHex(textEncoder.encode(value));
}

async function digestHex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

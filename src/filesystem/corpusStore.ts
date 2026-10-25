// Filesystem corpus mode (Bun only): a managed corpus directory for large local folders.
//
// Layout of `<corpusDir>`:
// - `payloads/<sha256[0..2]>/<sha256>`: raw bytes of every scanned file, stored once per hash.
// - `corpus.sqlite`: source/path aliases, parser state and extracted document records.
//   It holds no full-text tables; retrieval and ranking stay in nlp-stack.
// - `index/`: derived search-index state, rebuildable from the corpus records at any time.
// - `warc/<capture-id>.warc`: one WARC 1.1 file per explicit web capture (`captureUrls`); the
//   final response payload is also stored under `payloads/` like a scanned file.
//
// Documents are produced by the same import/extraction functions as the browser mode, so both
// modes share one corpus model (`ExtractedDocument`) and one corpus-core export.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  decodeUploadedBytes,
  isSupportedDocument,
  parseUploadedDocument,
} from "../domain/documentImport";
import { extractHtmlDocument } from "../domain/htmlExtraction";
import { searchCorpus } from "../domain/search";
import type {
  ExtractedDocument,
  HtmlDocumentInput,
  SearchRequestState,
  SearchResultView,
} from "../domain/types";
import {
  createCorpusCoreBatch,
  serializeCorpusCoreBatch,
  type WebCaptureExportInput,
} from "../storage/corpusCoreExport";
import {
  captureHttp,
  decodeContentCoding,
  parseContentType,
  WEB_CAPTURE_PRODUCER,
  WEB_CAPTURE_VERSION,
  type HttpCaptureOptions,
  type HttpCaptureResult,
} from "./webCapture";
import {
  concatBytes,
  deterministicRecordId,
  headerValue,
  httpHeaderBlock,
  labelledSha256,
  REVISIT_PROFILE,
  serializeWarcRecord,
  warcDate,
  type HeaderList,
} from "./warc";

/** Turns the raw bytes of one supported file into the shared document-import input. */
export interface ParserAdapter {
  /** Stable parser id, recorded per source; changing it re-parses the source. */
  id: string;
  /** Whether this adapter handles the POSIX path below the scanned root. */
  supports(relativePath: string): boolean;
  parse(input: { name: string; bytes: Uint8Array; importedAt: string }): HtmlDocumentInput;
}

export interface IngestOptions {
  /** ISO timestamp for new or changed documents; defaults to now. */
  importedAt?: string;
  /** Parser adapters in priority order (first match wins); defaults to DEFAULT_PARSER_ADAPTERS. */
  parsers?: readonly ParserAdapter[];
}

export interface IngestReport {
  root: string;
  files: number;
  added: number;
  updated: number;
  unchanged: number;
  removed: number;
  unsupported: number;
}

/** One file path ("path alias") below one or more scanned roots. */
export interface FilesystemSource {
  sourceUri: string;
  /**
   * The most specific (longest) scanned root containing the file, when overlapping roots were
   * scanned. Independent of scan order; every containing root keeps its own membership.
   */
  root: string;
  /** POSIX path of the file below `root`. */
  relativePath: string;
  sha256: string;
  byteLength: number;
  status: "parsed" | "unsupported";
  parser: string | null;
  documentId: string | null;
}

export type SearchIndexState = "missing" | "stale" | "current";

/** Extractor id recorded for web captures whose final response is HTML, Markdown or text. */
export const WEB_CAPTURE_EXTRACTOR = "web-capture/document-import";

export type CaptureOptions = HttpCaptureOptions;

/** One hop of a capture's redirect chain; the last hop is the final response. */
export interface WebCaptureHop {
  url: string;
  status: number;
  location: string | null;
  retrievedAt: string;
}

/**
 * One explicit retrieval of one requested URL. Every capture is its own record (and, when its
 * text was extracted, its own document), even when its payload bytes equal another capture's.
 */
export interface WebCapture {
  captureId: string;
  requestedUrl: string;
  finalUrl: string;
  /** Retrieval timestamp of the final response. */
  retrievedAt: string;
  redirectChain: WebCaptureHop[];
  status: number;
  reason: string;
  /** Final response header fields in received order. */
  headers: [string, string][];
  /** Raw Content-Type header of the final response. */
  contentType: string | null;
  mediaType: string | null;
  charset: string | null;
  contentEncoding: string | null;
  /** SHA-256 of the exact final entity bytes, stored once under `payloads/`. */
  payloadSha256: string;
  payloadByteLength: number;
  warc: {
    /** Path relative to the corpus directory. */
    path: string;
    sha256: string;
    /** Record id of the final `response` (or `revisit`) record. */
    responseRecordId: string;
    /** Set when the final record is a revisit of an earlier capture's identical payload. */
    revisitOf: string | null;
  };
  producer: { name: string; version: string };
  extraction: {
    status: "parsed" | "unsupported";
    extractor: string | null;
    /** Why no text was extracted, when unsupported. */
    reason: string | null;
  };
  documentId: string | null;
}

export interface CaptureReport {
  captures: WebCapture[];
  failed: { url: string; error: string }[];
}

export interface FilesystemCorpus {
  ingestFolder(root: string, options?: IngestOptions): Promise<IngestReport>;
  listSources(): Promise<FilesystemSource[]>;
  resolveSource(filePath: string): Promise<FilesystemSource | undefined>;
  listDocuments(): Promise<ExtractedDocument[]>;
  readPayload(sha256: string): Promise<Uint8Array | undefined>;
  rebuildSearchIndex(): Promise<{ documents: number }>;
  indexStatus(): Promise<{ state: SearchIndexState }>;
  search(request: SearchRequestState): Promise<SearchResultView[]>;
  exportCorpusCore(producerRevision: string): Promise<string>;
  /** Explicitly fetches each URL once and stores it as a WARC-backed web capture. */
  captureUrls(urls: readonly string[], options?: CaptureOptions): Promise<CaptureReport>;
  listCaptures(): Promise<WebCapture[]>;
  readCapture(captureId: string): Promise<WebCapture | undefined>;
  /** The exact stored final-response entity bytes of a capture. */
  readCapturePayload(captureId: string): Promise<Uint8Array | undefined>;
  readCaptureWarc(captureId: string): Promise<Uint8Array | undefined>;
  close(): void;
}

/** The browser upload import (HTML, Markdown, plain text) as a filesystem parser adapter. */
export const DOCUMENT_IMPORT_ADAPTER: ParserAdapter = {
  id: "document-import",
  supports: (relativePath) => isSupportedDocument(relativePath),
  parse: ({ name, bytes, importedAt }) => {
    const decoded = decodeUploadedBytes(bytes);
    return parseUploadedDocument({
      name,
      content: decoded.content,
      originalContent: decoded.originalContent,
      importedAt,
    });
  },
};

export const DEFAULT_PARSER_ADAPTERS: readonly ParserAdapter[] = [DOCUMENT_IMPORT_ADAPTER];

const SCHEMA_VERSION = 2;
const INDEX_MANIFEST_SCHEMA = "document-search-filesystem-index";
const INDEX_MANIFEST_SCHEMA_VERSION = 1;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** Document id of a filesystem source. It depends only on the source URI, never on bytes or time. */
export async function filesystemDocumentId(sourceUri: string): Promise<string> {
  return documentIdSync(sourceUri);
}

export async function openFilesystemCorpus(corpusDir: string): Promise<FilesystemCorpus> {
  const directory = resolve(corpusDir);
  mkdirSync(directory, { recursive: true });
  const database = new Database(join(directory, "corpus.sqlite"), { create: true, strict: true });
  try {
    migrate(database);
  } catch (error) {
    database.close();
    throw error;
  }
  return new SqliteFilesystemCorpus(directory, database);
}

interface SourceRow {
  source_uri: string;
  root: string;
  relative_path: string;
  sha256: string;
  byte_length: number;
  status: "parsed" | "unsupported";
  parser: string | null;
  document_id: string | null;
}

/**
 * Source rows with the root membership a `FilesystemSource` reports: the most specific (longest)
 * scanned root containing the file. Nested roots of one file always differ in length, so the
 * choice is independent of scan order; the root path breaks ties defensively.
 */
const SOURCE_ROWS_SQL = `SELECT s.source_uri, r.root, r.relative_path, s.sha256, s.byte_length,
    s.status, s.parser, s.document_id
  FROM sources AS s
  JOIN source_roots AS r ON r.source_uri = s.source_uri AND r.root = (
    SELECT m.root FROM source_roots AS m WHERE m.source_uri = s.source_uri
    ORDER BY length(m.root) DESC, m.root LIMIT 1
  )`;

interface IndexManifest {
  schema: typeof INDEX_MANIFEST_SCHEMA;
  schemaVersion: typeof INDEX_MANIFEST_SCHEMA_VERSION;
  documents: number;
  corpusDigest: string;
}

function migrate(database: Database): void {
  const { user_version: version } = database
    .query<{ user_version: number }, []>("PRAGMA user_version")
    .get() ?? { user_version: 0 };
  if (version === SCHEMA_VERSION) {
    return;
  }
  if (version < 0 || version > SCHEMA_VERSION) {
    throw new Error(
      `Unsupported filesystem corpus schema version ${version}; expected ${SCHEMA_VERSION}.`,
    );
  }
  database.transaction(() => {
    if (version < 1) createSchemaV1(database);
    if (version < 2) createSchemaV2(database);
    database.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  })();
}

function createSchemaV1(database: Database): void {
  database.run(`CREATE TABLE payloads (
      sha256 TEXT PRIMARY KEY NOT NULL,
      byte_length INTEGER NOT NULL
    ) STRICT`);
  database.run(`CREATE TABLE sources (
      source_uri TEXT PRIMARY KEY NOT NULL,
      sha256 TEXT NOT NULL REFERENCES payloads (sha256),
      byte_length INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('parsed', 'unsupported')),
      parser TEXT,
      document_id TEXT UNIQUE,
      CHECK ((status = 'parsed') = (parser IS NOT NULL AND document_id IS NOT NULL))
    ) STRICT`);
  // Every scanned root that contains a source; overlapping roots each keep their membership.
  database.run(`CREATE TABLE source_roots (
      source_uri TEXT NOT NULL REFERENCES sources (source_uri) ON DELETE CASCADE,
      root TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      PRIMARY KEY (source_uri, root)
    ) STRICT`);
  database.run("CREATE INDEX source_roots_by_root ON source_roots (root)");
  database.run(`CREATE TABLE documents (
      id TEXT PRIMARY KEY NOT NULL,
      source_uri TEXT NOT NULL UNIQUE REFERENCES sources (source_uri) ON DELETE CASCADE,
      record TEXT NOT NULL,
      record_sha256 TEXT NOT NULL
    ) STRICT`);
}

/**
 * Web captures. Each capture owns one `sources` row keyed by its internal capture source key
 * (never a file URL, so folder scans never touch it) and references its payload by hash.
 */
function createSchemaV2(database: Database): void {
  database.run(`CREATE TABLE captures (
      capture_id TEXT PRIMARY KEY NOT NULL,
      source_key TEXT NOT NULL UNIQUE REFERENCES sources (source_uri),
      requested_url TEXT NOT NULL,
      retrieved_at TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL REFERENCES payloads (sha256),
      revisit INTEGER NOT NULL CHECK (revisit IN (0, 1)),
      record TEXT NOT NULL
    ) STRICT`);
  database.run("CREATE INDEX captures_by_payload ON captures (payload_sha256, revisit)");
}

class SqliteFilesystemCorpus implements FilesystemCorpus {
  private readonly directory: string;
  private readonly database: Database;
  private readonly payloadDir: string;
  private readonly indexDir: string;

  constructor(directory: string, database: Database) {
    this.directory = directory;
    this.database = database;
    this.payloadDir = join(directory, "payloads");
    this.indexDir = join(directory, "index");
    database.run("PRAGMA foreign_keys = ON");
  }

  async ingestFolder(root: string, options: IngestOptions = {}): Promise<IngestReport> {
    const resolvedRoot = resolve(root);
    const importedAt = options.importedAt ?? new Date().toISOString();
    const parsers = options.parsers ?? DEFAULT_PARSER_ADAPTERS;
    const report: IngestReport = {
      root: resolvedRoot,
      files: 0,
      added: 0,
      updated: 0,
      unchanged: 0,
      removed: 0,
      unsupported: 0,
    };

    const findSource = this.database.query<{ sha256: string; parser: string | null }, [string]>(
      "SELECT sha256, parser FROM sources WHERE source_uri = ?",
    );
    const countRoots = this.database.query<{ count: number }, [string]>(
      "SELECT COUNT(*) AS count FROM source_roots WHERE source_uri = ?",
    );
    const seen = new Set<string>();

    const ingest = this.database.transaction((files: readonly string[]) => {
      for (const relativePath of files) {
        const absolutePath = join(resolvedRoot, ...relativePath.split("/"));
        const sourceUri = pathToFileURL(absolutePath).href;
        const bytes = new Uint8Array(readFileSync(absolutePath));
        const hash = sha256Hex(bytes);
        const parser = parsers.find((candidate) => candidate.supports(relativePath));
        report.files += 1;
        if (!parser) report.unsupported += 1;
        seen.add(sourceUri);

        this.storePayload(hash, bytes);
        const existing = findSource.get(sourceUri);
        // A file first reached through another, overlapping root is unchanged: only its root
        // membership is new, not its bytes or its parser.
        const change =
          existing === null
            ? "added"
            : existing.sha256 === hash && existing.parser === (parser?.id ?? null)
              ? "unchanged"
              : "updated";
        report[change] += 1;
        if (change !== "unchanged") {
          this.writeSource({ sourceUri, sha256: hash, bytes, importedAt, parser });
        }
        this.database.run(
          "INSERT OR REPLACE INTO source_roots (source_uri, root, relative_path) VALUES (?, ?, ?)",
          [sourceUri, resolvedRoot, relativePath],
        );
      }

      // A source this root no longer contains loses its membership here. The source goes away
      // when its file is gone or when no other scanned root still contains it.
      const members = this.database
        .query<{ source_uri: string; relative_path: string }, [string]>(
          "SELECT source_uri, relative_path FROM source_roots WHERE root = ?",
        )
        .all(resolvedRoot);
      for (const { source_uri: sourceUri, relative_path: relativePath } of members) {
        if (seen.has(sourceUri)) continue;
        report.removed += 1;
        this.database.run("DELETE FROM source_roots WHERE source_uri = ? AND root = ?", [
          sourceUri,
          resolvedRoot,
        ]);
        const remaining = countRoots.get(sourceUri)?.count ?? 0;
        if (remaining === 0 || !isRegularFile(join(resolvedRoot, ...relativePath.split("/")))) {
          this.database.run("DELETE FROM sources WHERE source_uri = ?", [sourceUri]);
        }
      }
    });

    ingest(listRegularFiles(resolvedRoot, this.directory));
    return report;
  }

  async listSources(): Promise<FilesystemSource[]> {
    return this.database
      .query<SourceRow, []>(SOURCE_ROWS_SQL)
      .all()
      .map(toFilesystemSource)
      .sort((left, right) => compareCodeUnits(left.sourceUri, right.sourceUri));
  }

  async resolveSource(filePath: string): Promise<FilesystemSource | undefined> {
    const row = this.database
      .query<SourceRow, [string]>(`${SOURCE_ROWS_SQL} WHERE s.source_uri = ?`)
      .get(pathToFileURL(resolve(filePath)).href);
    return row ? toFilesystemSource(row) : undefined;
  }

  async listDocuments(): Promise<ExtractedDocument[]> {
    return this.database
      .query<{ source_uri: string; record: string }, []>("SELECT source_uri, record FROM documents")
      .all()
      .sort((left, right) => compareCodeUnits(left.source_uri, right.source_uri))
      .map((row) => JSON.parse(row.record) as ExtractedDocument);
  }

  async readPayload(sha256: string): Promise<Uint8Array | undefined> {
    if (!SHA256_PATTERN.test(sha256)) {
      return undefined;
    }
    const path = this.payloadPath(sha256);
    return existsSync(path) ? new Uint8Array(readFileSync(path)) : undefined;
  }

  async rebuildSearchIndex(): Promise<{ documents: number }> {
    // The index is derived from the corpus records; every record must still have its payload.
    for (const { sha256 } of this.database
      .query<{ sha256: string }, []>("SELECT DISTINCT sha256 FROM sources")
      .all()) {
      if (!existsSync(this.payloadPath(sha256))) {
        throw new Error(`Corpus payload ${sha256} is missing; re-ingest its source folder.`);
      }
    }
    const documents = this.countDocuments();
    const manifest: IndexManifest = {
      schema: INDEX_MANIFEST_SCHEMA,
      schemaVersion: INDEX_MANIFEST_SCHEMA_VERSION,
      documents,
      corpusDigest: this.corpusDigest(),
    };
    mkdirSync(this.indexDir, { recursive: true });
    writeFileAtomically(
      join(this.indexDir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    return { documents };
  }

  async indexStatus(): Promise<{ state: SearchIndexState }> {
    const manifest = this.readIndexManifest();
    if (!manifest) {
      return { state: "missing" };
    }
    return { state: manifest.corpusDigest === this.corpusDigest() ? "current" : "stale" };
  }

  async search(request: SearchRequestState): Promise<SearchResultView[]> {
    const { state } = await this.indexStatus();
    if (state !== "current") {
      throw new Error(
        `The search index is ${state}; rebuild it (rebuild-index) before searching the corpus.`,
      );
    }
    // Ranking and filtering stay behind the shared nlp-stack search boundary.
    return searchCorpus(await this.listDocuments(), request);
  }

  async exportCorpusCore(producerRevision: string): Promise<string> {
    const captures = await this.listCaptures();
    const webCaptures = await Promise.all(
      captures.map(async (capture) => this.captureExportInput(capture)),
    );
    return serializeCorpusCoreBatch(
      await createCorpusCoreBatch(await this.listDocuments(), producerRevision, { webCaptures }),
    );
  }

  async captureUrls(urls: readonly string[], options: CaptureOptions = {}): Promise<CaptureReport> {
    const report: CaptureReport = { captures: [], failed: [] };
    for (const url of urls) {
      let result: HttpCaptureResult;
      try {
        result = await captureHttp(url, options);
      } catch (error) {
        report.failed.push({ url, error: errorMessage(error) });
        continue;
      }
      report.captures.push(this.storeCapture(result));
    }
    return report;
  }

  async listCaptures(): Promise<WebCapture[]> {
    return this.database
      .query<{ record: string }, []>(
        "SELECT record FROM captures ORDER BY retrieved_at, capture_id",
      )
      .all()
      .map((row) => JSON.parse(row.record) as WebCapture);
  }

  async readCapture(captureId: string): Promise<WebCapture | undefined> {
    const row = this.database
      .query<{ record: string }, [string]>("SELECT record FROM captures WHERE capture_id = ?")
      .get(captureId);
    return row ? (JSON.parse(row.record) as WebCapture) : undefined;
  }

  async readCapturePayload(captureId: string): Promise<Uint8Array | undefined> {
    const capture = await this.readCapture(captureId);
    return capture ? this.readPayload(capture.payloadSha256) : undefined;
  }

  async readCaptureWarc(captureId: string): Promise<Uint8Array | undefined> {
    const capture = await this.readCapture(captureId);
    if (!capture) return undefined;
    const path = join(this.directory, ...capture.warc.path.split("/"));
    return existsSync(path) ? new Uint8Array(readFileSync(path)) : undefined;
  }

  close(): void {
    this.database.close();
  }

  private writeSource(source: {
    sourceUri: string;
    sha256: string;
    bytes: Uint8Array;
    importedAt: string;
    parser: ParserAdapter | undefined;
  }): void {
    const documentId = source.parser ? documentIdSync(source.sourceUri) : null;
    this.database.run(
      `INSERT INTO sources (source_uri, sha256, byte_length, status, parser, document_id)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (source_uri) DO UPDATE SET
         sha256 = excluded.sha256,
         byte_length = excluded.byte_length,
         status = excluded.status,
         parser = excluded.parser,
         document_id = excluded.document_id`,
      [
        source.sourceUri,
        source.sha256,
        source.bytes.byteLength,
        source.parser ? "parsed" : "unsupported",
        source.parser?.id ?? null,
        documentId,
      ],
    );
    if (!source.parser || documentId === null) {
      this.database.run("DELETE FROM documents WHERE source_uri = ?", [source.sourceUri]);
      return;
    }

    const name = basename(fileURLToPath(source.sourceUri));
    let input: HtmlDocumentInput;
    try {
      input = source.parser.parse({ name, bytes: source.bytes, importedAt: source.importedAt });
    } catch (error) {
      throw new Error(
        `Parser ${source.parser.id} failed for ${source.sourceUri}: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    const document = extractHtmlDocument({ ...input, id: documentId, sourceUri: source.sourceUri });
    const record = JSON.stringify(document);
    this.database.run(
      `INSERT INTO documents (id, source_uri, record, record_sha256) VALUES (?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         source_uri = excluded.source_uri,
         record = excluded.record,
         record_sha256 = excluded.record_sha256`,
      [documentId, source.sourceUri, record, sha256Hex(new TextEncoder().encode(record))],
    );
  }

  private storeCapture(result: HttpCaptureResult): WebCapture {
    const final = result.exchanges.at(-1)!;
    const firstRetrievedAt = result.exchanges[0]!.retrievedAt;
    const captureId = `capture-${sha256Hex(
      new TextEncoder().encode(`${result.requestedUrl}\0${firstRetrievedAt}`),
    ).slice(0, 32)}`;
    if (this.readCaptureRow(captureId)) {
      throw new Error(`Capture ${captureId} already exists (same URL and retrieval time).`);
    }
    const sourceKey = `urn:document-search:capture:${captureId}`;
    const body = final.response.body;
    const payloadSha256 = sha256Hex(body);
    const earlier = this.database
      .query<{ record: string }, [string]>(
        `SELECT record FROM captures WHERE payload_sha256 = ? AND revisit = 0
         ORDER BY retrieved_at, capture_id LIMIT 1`,
      )
      .get(payloadSha256);
    const revisitOf = earlier ? (JSON.parse(earlier.record) as WebCapture) : undefined;

    const warc = buildCaptureWarc(captureId, result, revisitOf);
    const warcPath = `warc/${captureId}.warc`;
    const contentType = headerValue(final.response.headers, "content-type") ?? null;
    const { mediaType, charset } = parseContentType(contentType ?? undefined);
    const extracted = extractCapturedDocument(
      result,
      mediaType,
      charset,
      documentIdSync(sourceKey),
    );
    const capture: WebCapture = {
      captureId,
      requestedUrl: result.requestedUrl,
      finalUrl: result.finalUrl,
      retrievedAt: final.retrievedAt,
      redirectChain: result.exchanges.map((exchange) => ({
        url: exchange.request.url,
        status: exchange.response.status,
        location: headerValue(exchange.response.headers, "location") ?? null,
        retrievedAt: exchange.retrievedAt,
      })),
      status: final.response.status,
      reason: final.response.reason,
      headers: final.response.headers,
      contentType,
      mediaType,
      charset,
      contentEncoding: headerValue(final.response.headers, "content-encoding") ?? null,
      payloadSha256,
      payloadByteLength: body.byteLength,
      warc: {
        path: warcPath,
        sha256: sha256Hex(warc.bytes),
        responseRecordId: warc.responseRecordId,
        revisitOf: revisitOf?.warc.responseRecordId ?? null,
      },
      producer: { name: WEB_CAPTURE_PRODUCER, version: WEB_CAPTURE_VERSION },
      extraction: extracted.document
        ? { status: "parsed", extractor: WEB_CAPTURE_EXTRACTOR, reason: null }
        : { status: "unsupported", extractor: null, reason: extracted.reason },
      documentId: extracted.document?.id ?? null,
    };

    mkdirSync(join(this.directory, "warc"), { recursive: true });
    writeFileAtomically(join(this.directory, ...warcPath.split("/")), warc.bytes);
    this.database.transaction(() => {
      this.storePayload(payloadSha256, body);
      this.database.run(
        `INSERT INTO sources (source_uri, sha256, byte_length, status, parser, document_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          sourceKey,
          payloadSha256,
          body.byteLength,
          capture.extraction.status,
          capture.extraction.extractor,
          capture.documentId,
        ],
      );
      if (extracted.document) {
        const record = JSON.stringify(extracted.document);
        this.database.run(
          "INSERT INTO documents (id, source_uri, record, record_sha256) VALUES (?, ?, ?, ?)",
          [extracted.document.id, sourceKey, record, sha256Hex(new TextEncoder().encode(record))],
        );
      }
      this.database.run(
        `INSERT INTO captures
           (capture_id, source_key, requested_url, retrieved_at, payload_sha256, revisit, record)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          captureId,
          sourceKey,
          capture.requestedUrl,
          capture.retrievedAt,
          payloadSha256,
          revisitOf ? 1 : 0,
          JSON.stringify(capture),
        ],
      );
    })();
    return capture;
  }

  private readCaptureRow(captureId: string): { capture_id: string } | null {
    return this.database
      .query<{ capture_id: string }, [string]>(
        "SELECT capture_id FROM captures WHERE capture_id = ?",
      )
      .get(captureId);
  }

  private async captureExportInput(capture: WebCapture): Promise<WebCaptureExportInput> {
    const payload = await this.readPayload(capture.payloadSha256);
    if (!payload) {
      throw new Error(`Capture payload ${capture.payloadSha256} is missing from the corpus.`);
    }
    return {
      captureId: capture.captureId,
      documentId: capture.documentId,
      requestedUrl: capture.requestedUrl,
      finalUrl: capture.finalUrl,
      retrievedAt: capture.retrievedAt,
      status: capture.status,
      redirectChain: capture.redirectChain,
      contentType: capture.contentType,
      contentEncoding: capture.contentEncoding,
      payloadSha256: capture.payloadSha256,
      payloadByteLength: capture.payloadByteLength,
      payloadText: decodeUploadedBytes(payload).originalContent,
      warcPath: capture.warc.path,
      warcSha256: capture.warc.sha256,
      warcRecordId: capture.warc.responseRecordId,
      producer: capture.producer.name,
      producerVersion: capture.producer.version,
      extractor: capture.extraction.extractor,
    };
  }

  private storePayload(sha256: string, bytes: Uint8Array): void {
    const path = this.payloadPath(sha256);
    if (!existsSync(path)) {
      mkdirSync(join(this.payloadDir, sha256.slice(0, 2)), { recursive: true });
      writeFileAtomically(path, bytes);
    }
    this.database.run("INSERT OR IGNORE INTO payloads (sha256, byte_length) VALUES (?, ?)", [
      sha256,
      bytes.byteLength,
    ]);
  }

  private payloadPath(sha256: string): string {
    return join(this.payloadDir, sha256.slice(0, 2), sha256);
  }

  private countDocuments(): number {
    return (
      this.database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM documents").get()
        ?.count ?? 0
    );
  }

  /**
   * Deterministic digest of the indexed corpus state: every document's identity, inputs and the
   * hash of its stored record, so any record change (even bytes A -> B -> A with a new import
   * time) makes an existing index stale. Root memberships are not indexed and do not count.
   */
  private corpusDigest(): string {
    const rows = this.database
      .query<
        {
          source_uri: string;
          document_id: string;
          sha256: string;
          parser: string;
          record_sha256: string;
        },
        []
      >(
        `SELECT s.source_uri, d.id AS document_id, s.sha256, s.parser, d.record_sha256
           FROM documents AS d JOIN sources AS s ON s.source_uri = d.source_uri`,
      )
      .all()
      .sort((left, right) => compareCodeUnits(left.source_uri, right.source_uri));
    const hash = createHash("sha256");
    for (const row of rows) {
      hash.update(
        JSON.stringify([
          row.source_uri,
          row.document_id,
          row.sha256,
          row.parser,
          row.record_sha256,
        ]),
      );
      hash.update("\n");
    }
    return hash.digest("hex");
  }

  private readIndexManifest(): IndexManifest | undefined {
    const path = join(this.indexDir, "manifest.json");
    if (!existsSync(path)) {
      return undefined;
    }
    try {
      const manifest = JSON.parse(readFileSync(path, "utf8")) as Partial<IndexManifest>;
      return manifest.schema === INDEX_MANIFEST_SCHEMA &&
        manifest.schemaVersion === INDEX_MANIFEST_SCHEMA_VERSION &&
        typeof manifest.corpusDigest === "string" &&
        typeof manifest.documents === "number"
        ? (manifest as IndexManifest)
        : undefined;
    } catch {
      return undefined;
    }
  }
}

const TEXT_MEDIA_TYPES: Record<string, string> = {
  "text/html": "text/html",
  "application/xhtml+xml": "text/html",
  "text/markdown": "text/markdown",
  "text/x-markdown": "text/markdown",
  "text/plain": "text/plain",
};

/**
 * Readable text of a capture's final response, through the shared document-import extraction.
 * Only successful (2xx) HTML, Markdown and plain-text responses are extracted; the document's
 * `sourceUri` is the final URL and its import time the retrieval time.
 */
function extractCapturedDocument(
  result: HttpCaptureResult,
  mediaType: string | null,
  charset: string | null,
  documentId: string,
): { document: ExtractedDocument; reason?: undefined } | { document?: undefined; reason: string } {
  const final = result.exchanges.at(-1)!;
  if (final.response.status < 200 || final.response.status > 299) {
    return { reason: `HTTP status ${final.response.status}` };
  }
  const importType = mediaType === null ? undefined : TEXT_MEDIA_TYPES[mediaType];
  if (importType === undefined) {
    return { reason: `media type ${mediaType ?? "(none)"} has no text extractor` };
  }
  let bytes: Uint8Array;
  try {
    bytes = decodeContentCoding(final.response.body, final.response.headers);
  } catch (error) {
    return { reason: errorMessage(error) };
  }
  const exact = decodeUploadedBytes(bytes);
  let content = exact.content;
  if (charset !== null && charset !== "utf-8" && charset !== "utf8") {
    try {
      content = new TextDecoder(charset).decode(bytes);
    } catch {
      return { reason: `unsupported charset ${charset}` };
    }
  }
  const lossless = bytes === final.response.body && content === exact.content;
  const input = parseUploadedDocument({
    name: result.finalUrl,
    mimeType: importType,
    content,
    originalContent: lossless ? exact.originalContent : null,
    importedAt: final.retrievedAt,
  });
  // The URL is no title: let the extraction use the page's own <title>/<h1> first.
  const document = extractHtmlDocument({
    ...input,
    title: undefined,
    id: documentId,
    sourceUri: result.finalUrl,
  });
  return { document };
}

/** One WARC 1.1 file for a capture: warcinfo, then request/response per redirect hop. */
function buildCaptureWarc(
  captureId: string,
  result: HttpCaptureResult,
  revisitOf: WebCapture | undefined,
): { bytes: Uint8Array; responseRecordId: string } {
  const records: Uint8Array[] = [];
  const firstDate = warcDate(result.exchanges[0]!.retrievedAt);
  const warcinfoId = deterministicRecordId(captureId, "warcinfo");
  const fields = new TextEncoder().encode(
    [
      `software: ${WEB_CAPTURE_PRODUCER}/${WEB_CAPTURE_VERSION}`,
      `format: WARC File Format 1.1`,
      "conformsTo: https://iipc.github.io/warc-specifications/specifications/warc-format/warc-1.1/",
      `document-search-capture-id: ${captureId}`,
      `document-search-requested-url: ${result.requestedUrl}`,
      "",
    ].join("\r\n"),
  );
  records.push(
    serializeWarcRecord(
      [
        ["WARC-Type", "warcinfo"],
        ["WARC-Record-ID", warcinfoId],
        ["WARC-Date", firstDate],
        ["WARC-Filename", `${captureId}.warc`],
        ["Content-Type", "application/warc-fields"],
        ["WARC-Block-Digest", labelledSha256(fields)],
      ],
      fields,
    ),
  );

  let responseRecordId = "";
  result.exchanges.forEach((exchange, index) => {
    const date = warcDate(exchange.retrievedAt);
    const requestId = deterministicRecordId(captureId, "request", String(index));
    const responseId = deterministicRecordId(captureId, "response", String(index));
    const requestBlock = httpHeaderBlock(
      `GET ${exchange.request.target} HTTP/1.1`,
      exchange.request.headers,
    );
    records.push(
      serializeWarcRecord(
        [
          ["WARC-Type", "request"],
          ["WARC-Record-ID", requestId],
          ["WARC-Date", date],
          ["WARC-Target-URI", exchange.request.url],
          ["WARC-Concurrent-To", responseId],
          ["WARC-Warcinfo-ID", warcinfoId],
          ["Content-Type", "application/http;msgtype=request"],
          ["WARC-Block-Digest", labelledSha256(requestBlock)],
        ],
        requestBlock,
      ),
    );

    const response = exchange.response;
    const headerBlock = httpHeaderBlock(
      `HTTP/${response.httpVersion} ${response.status} ${response.reason}`.trimEnd(),
      archivedResponseHeaders(response.headers),
    );
    const isFinal = index === result.exchanges.length - 1;
    const revisit = isFinal && revisitOf !== undefined;
    const block = revisit ? headerBlock : concatBytes([headerBlock, response.body]);
    const headers: [string, string][] = [
      ["WARC-Type", revisit ? "revisit" : "response"],
      ["WARC-Record-ID", responseId],
      ["WARC-Date", date],
      ["WARC-Target-URI", exchange.request.url],
      ["WARC-Concurrent-To", requestId],
      ["WARC-Warcinfo-ID", warcinfoId],
      ...(response.ipAddress ? [["WARC-IP-Address", response.ipAddress] as [string, string]] : []),
      ["Content-Type", "application/http;msgtype=response"],
      ["WARC-Block-Digest", labelledSha256(block)],
      ["WARC-Payload-Digest", labelledSha256(response.body)],
    ];
    if (revisit) {
      headers.push(
        ["WARC-Profile", REVISIT_PROFILE],
        ["WARC-Refers-To", revisitOf.warc.responseRecordId],
        ["WARC-Refers-To-Target-URI", revisitOf.finalUrl],
        ["WARC-Refers-To-Date", warcDate(revisitOf.retrievedAt)],
      );
    }
    records.push(serializeWarcRecord(headers, block));
    if (isFinal) responseRecordId = responseId;
  });
  return { bytes: concatBytes(records), responseRecordId };
}

/**
 * Response header fields as archived. The entity body is stored with its transfer coding
 * already removed, so a `Transfer-Encoding` field is kept under the conventional
 * `X-Archive-Orig-` prefix instead of describing bytes that are not in the record.
 */
function archivedResponseHeaders(headers: HeaderList): [string, string][] {
  return headers.map(([name, value]) =>
    name.toLowerCase() === "transfer-encoding" ? [`X-Archive-Orig-${name}`, value] : [name, value],
  );
}

/**
 * Regular files below `root` as sorted POSIX relative paths. Symlinks are not followed, and the
 * corpus directory itself is skipped when it lies below the scanned root.
 */
function listRegularFiles(root: string, corpusDir: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    if (directory === corpusDir) {
      return;
    }
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      compareCodeUnits(left.name, right.name),
    );
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile()) {
        files.push(relative(root, path).split(sep).join("/"));
      }
    }
  };
  visit(root);
  return files;
}

function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function toFilesystemSource(row: SourceRow): FilesystemSource {
  return {
    sourceUri: row.source_uri,
    root: row.root,
    relativePath: row.relative_path,
    sha256: row.sha256,
    byteLength: row.byte_length,
    status: row.status,
    parser: row.parser,
    documentId: row.document_id,
  };
}

function writeFileAtomically(path: string, content: string | Uint8Array): void {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, content);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function documentIdSync(sourceUri: string): string {
  return `fsdoc-${sha256Hex(new TextEncoder().encode(`document-search/filesystem\0${sourceUri}`))}`;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

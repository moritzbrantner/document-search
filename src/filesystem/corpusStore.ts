// Filesystem corpus mode (Bun only): a managed corpus directory for large local folders.
//
// Layout of `<corpusDir>`:
// - `payloads/<sha256[0..2]>/<sha256>`: raw bytes of every scanned file, stored once per hash.
// - `corpus.sqlite`: source/path aliases, parser state and extracted document records.
//   It holds no full-text tables; retrieval and ranking stay in nlp-stack.
// - `index/`: derived search-index state, rebuildable from the corpus records at any time.
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
import { createCorpusCoreBatch, serializeCorpusCoreBatch } from "../storage/corpusCoreExport";

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

const SCHEMA_VERSION = 1;
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
  if (version !== 0) {
    throw new Error(
      `Unsupported filesystem corpus schema version ${version}; expected ${SCHEMA_VERSION}.`,
    );
  }
  database.transaction(() => {
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
    database.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  })();
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
    return serializeCorpusCoreBatch(
      await createCorpusCoreBatch(await this.listDocuments(), producerRevision),
    );
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

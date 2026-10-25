/**
 * Acceptance tests for issue #21: a filesystem corpus mode for large document folders.
 *
 * These tests are the specification. The implementation does not exist yet; every test
 * here fails only because `src/filesystem/corpusStore.ts` / `src/filesystem/cli.ts` are
 * missing.
 *
 * ## Contract
 *
 * Module `src/filesystem/corpusStore.ts` (Bun only: `bun:sqlite`, `node:fs`):
 *
 * ```ts
 * export function openFilesystemCorpus(corpusDir: string): Promise<FilesystemCorpus>;
 * export function filesystemDocumentId(sourceUri: string): Promise<string>;
 * export const DEFAULT_PARSER_ADAPTERS: readonly ParserAdapter[];
 *
 * export interface ParserAdapter {
 *   id: string;                                   // stable parser id, recorded per source
 *   supports(relativePath: string): boolean;      // POSIX path below the scanned root
 *   parse(input: { name: string; bytes: Uint8Array; importedAt: string }): HtmlDocumentInput;
 * }
 *
 * export interface IngestOptions {
 *   importedAt?: string;                // ISO timestamp for new/changed documents; default now
 *   parsers?: readonly ParserAdapter[]; // default DEFAULT_PARSER_ADAPTERS; first match wins
 * }
 *
 * export interface IngestReport {
 *   root: string;        // resolved absolute root
 *   files: number;       // regular files seen below root (recursive)
 *   added: number;       // new path aliases
 *   updated: number;     // existing aliases whose bytes (sha256) or parser changed
 *   unchanged: number;   // existing aliases with identical bytes and parser
 *   removed: number;     // aliases under this root whose file no longer exists
 *   unsupported: number; // subset of `files` that no parser adapter supports
 * }
 *
 * export interface FilesystemSource {     // one per file path ("path alias")
 *   sourceUri: string;                    // pathToFileURL(absolute file path).href
 *   root: string;                         // resolved absolute root it was scanned under
 *   relativePath: string;                 // POSIX-separated path below root
 *   sha256: string;                       // lowercase hex SHA-256 of the raw file bytes
 *   byteLength: number;
 *   status: "parsed" | "unsupported";
 *   parser: string | null;                // ParserAdapter.id, null when unsupported
 *   documentId: string | null;            // filesystemDocumentId(sourceUri), null when unsupported
 * }
 *
 * export interface FilesystemCorpus {
 *   ingestFolder(root: string, options?: IngestOptions): Promise<IngestReport>;
 *   listSources(): Promise<FilesystemSource[]>;           // sorted by sourceUri (code units)
 *   resolveSource(filePath: string): Promise<FilesystemSource | undefined>; // absolute path
 *   listDocuments(): Promise<ExtractedDocument[]>;        // sorted by sourceUri (code units)
 *   readPayload(sha256: string): Promise<Uint8Array | undefined>;
 *   rebuildSearchIndex(): Promise<{ documents: number }>;
 *   indexStatus(): Promise<{ state: "missing" | "stale" | "current" }>;
 *   search(request: SearchRequestState): Promise<SearchResultView[]>;
 *   exportCorpusCore(producerRevision: string): Promise<string>;
 *   close(): void | Promise<void>;
 * }
 * ```
 *
 * Corpus directory layout:
 * - `<corpusDir>/payloads/<sha256[0..2]>/<sha256>`: raw bytes of every scanned file (also
 *   unsupported ones, so later parser adapters such as PDF (#22) extract from the corpus
 *   alone), stored exactly once per hash.
 * - `<corpusDir>/corpus.sqlite`: `bun:sqlite` database with source/path aliases, parser
 *   state, extracted document records and index-sync metadata. No full-text tables: text
 *   ranking stays in nlp-stack.
 * - `<corpusDir>/index/`: derived search-index state written by `rebuildSearchIndex`. It
 *   may be deleted at any time; the corpus is unaffected and the index is rebuildable.
 *
 * Semantics:
 * - Shared with the browser mode: each supported file becomes the `ExtractedDocument`
 *   produced by `extractHtmlDocument({ ...parseUploadedDocument({ name: basename, content,
 *   originalContent, importedAt }), id: filesystemDocumentId(sourceUri), sourceUri })`
 *   with `decodeUploadedBytes(bytes)`; that is the default adapter (id `document-import`)
 *   plus id/sourceUri assignment. `exportCorpusCore(rev)` equals
 *   `serializeCorpusCoreBatch(await createCorpusCoreBatch(await listDocuments(), rev))`.
 * - Identity: a document is per path alias (the browser's "same page" semantics); its id
 *   depends only on `sourceUri`, never on bytes or time. Identical bytes at several paths
 *   share one payload file but keep one source (and document) per path.
 * - Re-scan of a root is deterministic: unchanged files keep their record, including their
 *   original `importedAt`; changed bytes keep the document id, point the alias at the new
 *   hash and take the re-scan's `importedAt`; deleted files lose their alias and document.
 *   Re-scanning one root never touches aliases of another root. Garbage collection of
 *   unreferenced payloads, symlinks and hidden files are intentionally unspecified.
 * - Index sync: `indexStatus` is `missing` without index state, `current` after a rebuild,
 *   `stale` after an ingest that changed the corpus, and stays `current` after a no-op
 *   re-scan. `search` rejects (message mentions "rebuild") unless the index is `current`,
 *   and otherwise returns exactly what `searchCorpus(await listDocuments(), request)`
 *   returns: ranking stays behind the existing nlp-stack search boundary.
 *
 * CLI `src/filesystem/cli.ts`, package script `"corpus": "bun src/filesystem/cli.ts"`. Every
 * command takes `--corpus <dir>`, prints JSON to stdout and exits 0; usage errors exit
 * non-zero:
 * - `ingest --corpus <dir> [--imported-at <iso>] <root>` prints the IngestReport.
 * - `sources --corpus <dir>` prints listSources().
 * - `rebuild-index --corpus <dir>` prints `{ "documents": n }`.
 * - `search --corpus <dir> [--top-k <n>] [--mode hybrid|lexical|semantic] <query>` prints
 *   search({ query, topK (default 10), mode (default "hybrid"), requireQuotedPhrases: true }).
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { decodeUploadedBytes, parseUploadedDocument } from "../domain/documentImport";
import { extractHtmlDocument } from "../domain/htmlExtraction";
import { searchCorpus } from "../domain/search";
import type { SearchRequestState } from "../domain/types";
import {
  DEFAULT_PARSER_ADAPTERS,
  filesystemDocumentId,
  openFilesystemCorpus,
  type FilesystemCorpus,
  type FilesystemSource,
  type ParserAdapter,
} from "../filesystem/corpusStore";
import {
  createCorpusCoreBatch,
  parseCorpusCoreBatch,
  serializeCorpusCoreBatch,
} from "../storage/corpusCoreExport";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const IMPORTED_AT = "2026-10-11T08:00:00.000Z";
const LATER = "2026-10-12T09:30:00.000Z";
const REVISION = "acceptance-rev";

const NOTES_MD = "# Retrieval notes\n\nLexical retrieval keeps zeppelin ranking in nlp-stack.\n";
const PAGE_HTML =
  "<html><head><title>Harbour page</title></head><body><h1>Harbour</h1><p>The lighthouse keeper counts herring boats.</p></body></html>";
const PLAIN_TXT = "Pantry inventory lists barley and lentils.\n\nSecond paragraph about oats.\n";
const FAKE_PDF = "%PDF-1.4\n% not really a pdf, extraction is issue #22\n";
const BLOB_BIN = new Uint8Array([0, 255, 1, 254, 2, 253, 0x80, 0x81]);

/** Nested fixture: 6 files, 4 supported, 2 unsupported, one duplicate pair. */
function writeFixture(root: string): void {
  writeFile(root, "a/notes.md", NOTES_MD);
  writeFile(root, "a/deep/nested/page.html", PAGE_HTML);
  writeFile(root, "b/copy-of-notes.md", NOTES_MD);
  writeFile(root, "b/plain.txt", PLAIN_TXT);
  writeFile(root, "c/report.pdf", FAKE_PDF);
  writeFile(root, "c/blob.bin", BLOB_BIN);
}

function writeFile(root: string, relativePath: string, content: string | Uint8Array): string {
  const path = join(root, ...relativePath.split("/"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function uriOf(root: string, relativePath: string): string {
  return pathToFileURL(join(root, ...relativePath.split("/"))).href;
}

function payloadFile(corpusDir: string, hash: string): string {
  return join(corpusDir, "payloads", hash.slice(0, 2), hash);
}

function listPayloadFiles(corpusDir: string): string[] {
  const base = join(corpusDir, "payloads");
  if (!existsSync(base)) return [];
  return readdirSync(base, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}

const tempDirs: string[] = [];
const openCorpora: FilesystemCorpus[] = [];

function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `document-search-fs-${label}-`));
  tempDirs.push(dir);
  return dir;
}

async function open(corpusDir: string): Promise<FilesystemCorpus> {
  const corpus = await openFilesystemCorpus(corpusDir);
  openCorpora.push(corpus);
  return corpus;
}

async function closeCorpus(corpus: FilesystemCorpus): Promise<void> {
  const index = openCorpora.indexOf(corpus);
  if (index >= 0) openCorpora.splice(index, 1);
  await corpus.close();
}

afterEach(async () => {
  for (const corpus of openCorpora.splice(0)) await corpus.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SEARCH_REQUEST: SearchRequestState = {
  query: "lighthouse herring",
  topK: 5,
  mode: "hybrid",
  requireQuotedPhrases: true,
};

describe("AC1: nested folder builds and rebuilds deterministically", () => {
  test("ingesting a nested folder records every file below it", async () => {
    const root = tempDir("root");
    writeFixture(root);
    const corpus = await open(join(tempDir("corpus"), "store"));

    const report = await corpus.ingestFolder(root, { importedAt: IMPORTED_AT });
    expect(report).toEqual({
      root: resolve(root),
      files: 6,
      added: 6,
      updated: 0,
      unchanged: 0,
      removed: 0,
      unsupported: 2,
    });

    const sources = await corpus.listSources();
    const expectedOrder = [
      "a/deep/nested/page.html",
      "a/notes.md",
      "b/copy-of-notes.md",
      "b/plain.txt",
      "c/blob.bin",
      "c/report.pdf",
    ]
      .map((relativePath) => uriOf(root, relativePath))
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    expect(sources.map((source) => source.sourceUri)).toEqual(expectedOrder);

    const page = sources.find((source) => source.relativePath === "a/deep/nested/page.html");
    expect(page).toEqual({
      sourceUri: uriOf(root, "a/deep/nested/page.html"),
      root: resolve(root),
      relativePath: "a/deep/nested/page.html",
      sha256: sha256(PAGE_HTML),
      byteLength: Buffer.byteLength(PAGE_HTML),
      status: "parsed",
      parser: "document-import",
      documentId: await filesystemDocumentId(uriOf(root, "a/deep/nested/page.html")),
    });
    for (const source of sources) {
      expect(source.sha256).toMatch(/^[0-9a-f]{64}$/);
    }

    const documents = await corpus.listDocuments();
    expect(documents.map((document) => document.sourceUri)).toEqual(
      expectedOrder.filter((uri) => !uri.endsWith(".pdf") && !uri.endsWith(".bin")),
    );
    const pageDocument = documents.find((document) => document.id === page?.documentId);
    expect(pageDocument?.text).toContain("lighthouse keeper counts herring boats");
  });

  test("a re-scan of the unchanged folder creates no duplicates and changes nothing", async () => {
    const root = tempDir("root");
    writeFixture(root);
    const corpusDir = tempDir("corpus");
    const corpus = await open(corpusDir);
    await corpus.ingestFolder(root, { importedAt: IMPORTED_AT });
    const sourcesBefore = JSON.stringify(await corpus.listSources());
    const documentsBefore = JSON.stringify(await corpus.listDocuments());
    const exportBefore = await corpus.exportCorpusCore(REVISION);
    const payloadsBefore = listPayloadFiles(corpusDir);

    // A later clock must not leak into unchanged records.
    const report = await corpus.ingestFolder(root, { importedAt: LATER });
    expect(report).toEqual({
      root: resolve(root),
      files: 6,
      added: 0,
      updated: 0,
      unchanged: 6,
      removed: 0,
      unsupported: 2,
    });
    expect(JSON.stringify(await corpus.listSources())).toBe(sourcesBefore);
    expect(JSON.stringify(await corpus.listDocuments())).toBe(documentsBefore);
    expect(await corpus.exportCorpusCore(REVISION)).toBe(exportBefore);
    expect(listPayloadFiles(corpusDir)).toEqual(payloadsBefore);
  });

  test("two independent builds of the same folder are byte-identical", async () => {
    const root = tempDir("root");
    writeFixture(root);
    const first = await open(tempDir("corpus-a"));
    const second = await open(tempDir("corpus-b"));
    await first.ingestFolder(root, { importedAt: IMPORTED_AT });
    await second.ingestFolder(root, { importedAt: IMPORTED_AT });

    expect(JSON.stringify(await second.listSources())).toBe(
      JSON.stringify(await first.listSources()),
    );
    expect(JSON.stringify(await second.listDocuments())).toBe(
      JSON.stringify(await first.listDocuments()),
    );
    expect(await second.exportCorpusCore(REVISION)).toBe(await first.exportCorpusCore(REVISION));
  });

  test("document ids depend only on the source URI", async () => {
    const uri = "file:///corpus/a/notes.md";
    const id = await filesystemDocumentId(uri);
    expect(await filesystemDocumentId(uri)).toBe(id);
    expect(await filesystemDocumentId("file:///corpus/b/notes.md")).not.toBe(id);
    expect(id.length).toBeGreaterThan(0);
  });

  test("a re-scan follows modified bytes and removed files", async () => {
    const root = tempDir("root");
    writeFixture(root);
    const corpusDir = tempDir("corpus");
    const corpus = await open(corpusDir);
    await corpus.ingestFolder(root, { importedAt: IMPORTED_AT });
    const notesBefore = await corpus.resolveSource(join(root, "a", "notes.md"));

    const changed = "# Retrieval notes\n\nRewritten notes mention a quokka instead.\n";
    writeFile(root, "a/notes.md", changed);
    rmSync(join(root, "b", "plain.txt"));

    const report = await corpus.ingestFolder(root, { importedAt: LATER });
    expect(report).toEqual({
      root: resolve(root),
      files: 5,
      added: 0,
      updated: 1,
      unchanged: 4,
      removed: 1,
      unsupported: 2,
    });

    const notes = await corpus.resolveSource(join(root, "a", "notes.md"));
    expect(notes?.sha256).toBe(sha256(changed));
    expect(notes?.documentId).toBe(notesBefore?.documentId ?? "missing");
    expect(Buffer.from((await corpus.readPayload(sha256(changed))) ?? [])).toEqual(
      Buffer.from(changed),
    );
    expect(readFileSync(payloadFile(corpusDir, sha256(changed)), "utf8")).toBe(changed);

    const documents = await corpus.listDocuments();
    const notesDocument = documents.find((document) => document.id === notes?.documentId);
    expect(notesDocument?.text).toContain("quokka");
    expect(notesDocument?.importedAt).toBe(LATER);
    // The untouched duplicate keeps the old bytes and its original import time.
    const copy = await corpus.resolveSource(join(root, "b", "copy-of-notes.md"));
    expect(copy?.sha256).toBe(sha256(NOTES_MD));
    expect(documents.find((document) => document.id === copy?.documentId)?.importedAt).toBe(
      IMPORTED_AT,
    );

    expect(await corpus.resolveSource(join(root, "b", "plain.txt"))).toBeUndefined();
    const plainUri = uriOf(root, "b/plain.txt");
    expect((await corpus.listSources()).some((source) => source.sourceUri === plainUri)).toBe(
      false,
    );
    expect(documents.some((document) => document.sourceUri === plainUri)).toBe(false);
  });
});

describe("AC2: identical bytes are stored once and discoverable through every path", () => {
  test("duplicates across folders and roots share one payload file", async () => {
    const root = tempDir("root");
    writeFixture(root);
    const otherRoot = tempDir("other-root");
    writeFile(otherRoot, "archive/2026/notes-backup.md", NOTES_MD);
    const corpusDir = tempDir("corpus");
    const corpus = await open(corpusDir);

    await corpus.ingestFolder(root, { importedAt: IMPORTED_AT });
    await corpus.ingestFolder(otherRoot, { importedAt: IMPORTED_AT });

    const hash = sha256(NOTES_MD);
    const paths = [
      join(root, "a", "notes.md"),
      join(root, "b", "copy-of-notes.md"),
      join(otherRoot, "archive", "2026", "notes-backup.md"),
    ];
    const aliases = await Promise.all(paths.map((path) => corpus.resolveSource(path)));
    expect(aliases.map((alias) => alias?.sha256)).toEqual([hash, hash, hash]);
    expect(aliases.map((alias) => alias?.sourceUri)).toEqual(
      paths.map((path) => pathToFileURL(path).href),
    );
    // Each path keeps its own source and document.
    expect(new Set(aliases.map((alias) => alias?.documentId)).size).toBe(3);

    // Stored exactly once on disk, with the exact bytes.
    expect(listPayloadFiles(corpusDir).filter((name) => name === hash)).toEqual([hash]);
    expect(readFileSync(payloadFile(corpusDir, hash), "utf8")).toBe(NOTES_MD);
    // One payload file per distinct hash across all scanned files (supported or not).
    const distinct = new Set([
      hash,
      sha256(PAGE_HTML),
      sha256(PLAIN_TXT),
      sha256(FAKE_PDF),
      sha256(BLOB_BIN),
    ]);
    expect(listPayloadFiles(corpusDir)).toEqual([...distinct].sort());

    // Every path is discoverable as a document carrying its own source URI.
    const documents = await corpus.listDocuments();
    for (const alias of aliases) {
      expect(documents.find((document) => document.id === alias?.documentId)?.sourceUri).toBe(
        alias?.sourceUri ?? "missing",
      );
    }
  });

  test("re-scanning one root keeps the aliases of another root", async () => {
    const root = tempDir("root");
    writeFixture(root);
    const otherRoot = tempDir("other-root");
    const backup = writeFile(otherRoot, "notes-backup.md", NOTES_MD);
    const corpus = await open(tempDir("corpus"));
    await corpus.ingestFolder(root, { importedAt: IMPORTED_AT });
    await corpus.ingestFolder(otherRoot, { importedAt: IMPORTED_AT });

    rmSync(join(root, "a", "notes.md"));
    const report = await corpus.ingestFolder(root, { importedAt: LATER });
    expect(report.removed).toBe(1);

    expect((await corpus.resolveSource(backup))?.sha256).toBe(sha256(NOTES_MD));
    expect(await corpus.resolveSource(join(root, "a", "notes.md"))).toBeUndefined();
    expect(Buffer.from((await corpus.readPayload(sha256(NOTES_MD))) ?? [])).toEqual(
      Buffer.from(NOTES_MD),
    );
  });
});

describe("AC3: corpus metadata survives restart independently of the search index", () => {
  test("close and reopen restores records without any index", async () => {
    const root = tempDir("root");
    writeFixture(root);
    const corpusDir = tempDir("corpus");
    const corpus = await open(corpusDir);
    await corpus.ingestFolder(root, { importedAt: IMPORTED_AT });
    const sources = JSON.stringify(await corpus.listSources());
    const documents = JSON.stringify(await corpus.listDocuments());
    expect((await corpus.indexStatus()).state).toBe("missing");
    await closeCorpus(corpus);

    expect(existsSync(join(corpusDir, "corpus.sqlite"))).toBe(true);
    const reopened = await open(corpusDir);
    expect(JSON.stringify(await reopened.listSources())).toBe(sources);
    expect(JSON.stringify(await reopened.listDocuments())).toBe(documents);
    expect((await reopened.indexStatus()).state).toBe("missing");
  });

  test("deleting the index directory leaves the corpus intact", async () => {
    const root = tempDir("root");
    writeFixture(root);
    const corpusDir = tempDir("corpus");
    const corpus = await open(corpusDir);
    await corpus.ingestFolder(root, { importedAt: IMPORTED_AT });
    await corpus.rebuildSearchIndex();
    expect((await corpus.indexStatus()).state).toBe("current");
    const sources = JSON.stringify(await corpus.listSources());
    const documents = JSON.stringify(await corpus.listDocuments());
    await closeCorpus(corpus);

    expect(existsSync(join(corpusDir, "index"))).toBe(true);
    rmSync(join(corpusDir, "index"), { recursive: true, force: true });

    const reopened = await open(corpusDir);
    expect(JSON.stringify(await reopened.listSources())).toBe(sources);
    expect(JSON.stringify(await reopened.listDocuments())).toBe(documents);
    expect((await reopened.indexStatus()).state).toBe("missing");
    await expect(reopened.search(SEARCH_REQUEST)).rejects.toThrow(/rebuild/i);
  });

  test("SQLite holds corpus records but no full-text ranking tables", async () => {
    const root = tempDir("root");
    writeFixture(root);
    const corpusDir = tempDir("corpus");
    const corpus = await open(corpusDir);
    await corpus.ingestFolder(root, { importedAt: IMPORTED_AT });
    await corpus.rebuildSearchIndex();
    await closeCorpus(corpus);

    const database = new Database(join(corpusDir, "corpus.sqlite"), { readonly: true });
    try {
      const schema = database
        .query<{ sql: string | null }, []>("SELECT sql FROM sqlite_master")
        .all()
        .map((row) => row.sql ?? "")
        .join("\n");
      expect(schema).not.toMatch(/fts[345]|virtual\s+table/i);
      expect(schema.length).toBeGreaterThan(0);
    } finally {
      database.close();
    }
  });
});

describe("AC4: the search index is rebuilt from corpus records and payloads", () => {
  test("index sync state follows ingests and rebuilds", async () => {
    const root = tempDir("root");
    writeFixture(root);
    const corpus = await open(tempDir("corpus"));
    expect((await corpus.indexStatus()).state).toBe("missing");

    await corpus.ingestFolder(root, { importedAt: IMPORTED_AT });
    expect(await corpus.rebuildSearchIndex()).toEqual({ documents: 4 });
    expect((await corpus.indexStatus()).state).toBe("current");

    await corpus.ingestFolder(root, { importedAt: LATER });
    expect((await corpus.indexStatus()).state).toBe("current");

    writeFile(root, "b/new-note.txt", "A fresh note about cormorants.\n");
    await corpus.ingestFolder(root, { importedAt: LATER });
    expect((await corpus.indexStatus()).state).toBe("stale");
    await expect(corpus.search(SEARCH_REQUEST)).rejects.toThrow(/rebuild/i);

    expect(await corpus.rebuildSearchIndex()).toEqual({ documents: 5 });
    expect((await corpus.indexStatus()).state).toBe("current");
  });

  test("a rebuilt index searches ingested content through the nlp-stack boundary", async () => {
    const root = tempDir("root");
    writeFixture(root);
    const corpusDir = tempDir("corpus");
    const corpus = await open(corpusDir);
    await corpus.ingestFolder(root, { importedAt: IMPORTED_AT });
    await closeCorpus(corpus);
    rmSync(join(corpusDir, "index"), { recursive: true, force: true });

    const reopened = await open(corpusDir);
    await reopened.rebuildSearchIndex();
    const results = await reopened.search(SEARCH_REQUEST);
    const page = await reopened.resolveSource(join(root, "a", "deep", "nested", "page.html"));

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.documentId).toBe(page?.documentId ?? "missing");
    expect(results[0]?.snippet).toContain("lighthouse");
    expect(results).toEqual(await searchCorpus(await reopened.listDocuments(), SEARCH_REQUEST));

    const duplicateHits = await reopened.search({
      ...SEARCH_REQUEST,
      query: "zeppelin",
      mode: "lexical",
    });
    const notesIds = [
      (await reopened.resolveSource(join(root, "a", "notes.md")))?.documentId,
      (await reopened.resolveSource(join(root, "b", "copy-of-notes.md")))?.documentId,
    ];
    expect(new Set(duplicateHits.map((hit) => hit.documentId))).toEqual(new Set(notesIds));
  });
});

describe("AC5: browser and filesystem modes share corpus semantics", () => {
  test("documents are produced by the shared import and extraction functions", async () => {
    const root = tempDir("root");
    writeFixture(root);
    const bomText = writeFile(
      root,
      "d/bom.txt",
      new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from("Byte order mark note.\n")]),
    );
    const corpus = await open(tempDir("corpus"));
    await corpus.ingestFolder(root, { importedAt: IMPORTED_AT });

    const supported = [
      join(root, "a", "notes.md"),
      join(root, "a", "deep", "nested", "page.html"),
      join(root, "b", "plain.txt"),
      bomText,
    ];
    const documents = await corpus.listDocuments();
    for (const path of supported) {
      const sourceUri = pathToFileURL(path).href;
      const decoded = decodeUploadedBytes(new Uint8Array(readFileSync(path)));
      const expected = extractHtmlDocument({
        ...parseUploadedDocument({
          name: basename(path),
          content: decoded.content,
          originalContent: decoded.originalContent,
          importedAt: IMPORTED_AT,
        }),
        id: await filesystemDocumentId(sourceUri),
        sourceUri,
      });
      expect(documents.find((document) => document.sourceUri === sourceUri)).toEqual(expected);
    }
  });

  test("corpus-core export is the shared export of the stored documents", async () => {
    const root = tempDir("root");
    writeFixture(root);
    const corpus = await open(tempDir("corpus"));
    await corpus.ingestFolder(root, { importedAt: IMPORTED_AT });

    const exported = await corpus.exportCorpusCore(REVISION);
    expect(exported).toBe(
      serializeCorpusCoreBatch(await createCorpusCoreBatch(await corpus.listDocuments(), REVISION)),
    );

    // The content-addressed payload hash is the corpus-core asset content hash.
    const batch = parseCorpusCoreBatch(exported);
    const notesUri = uriOf(root, "a/notes.md");
    const asset = batch.records.find(
      (record) => record.record_type === "asset" && record.record.content.uri === notesUri,
    );
    expect(asset?.record_type === "asset" ? asset.record.content.hash : undefined).toBe(
      sha256(NOTES_MD),
    );
    expect(batch.payloads.filter((payload) => payload.hash === sha256(NOTES_MD))).toHaveLength(1);
  });

  test("the default parser adapter is the shared document import", () => {
    expect(DEFAULT_PARSER_ADAPTERS.map((adapter) => adapter.id)).toEqual(["document-import"]);
    const [adapter] = DEFAULT_PARSER_ADAPTERS;
    expect(adapter?.supports("x/notes.md")).toBe(true);
    expect(adapter?.supports("x/page.HTM")).toBe(true);
    expect(adapter?.supports("x/plain.txt")).toBe(true);
    expect(adapter?.supports("x/report.pdf")).toBe(false);
    expect(adapter?.supports("x/blob.bin")).toBe(false);
    expect(
      adapter?.parse({ name: "notes.md", bytes: Buffer.from(NOTES_MD), importedAt: IMPORTED_AT }),
    ).toEqual(
      parseUploadedDocument({ name: "notes.md", content: NOTES_MD, importedAt: IMPORTED_AT }),
    );
  });
});

describe("AC6: parser adapter seam", () => {
  test("unsupported files are recorded deterministically without documents", async () => {
    const root = tempDir("root");
    writeFixture(root);
    const corpusDir = tempDir("corpus");
    const corpus = await open(corpusDir);
    await corpus.ingestFolder(root, { importedAt: IMPORTED_AT });

    const pdf = await corpus.resolveSource(join(root, "c", "report.pdf"));
    expect(pdf).toEqual({
      sourceUri: uriOf(root, "c/report.pdf"),
      root: resolve(root),
      relativePath: "c/report.pdf",
      sha256: sha256(FAKE_PDF),
      byteLength: Buffer.byteLength(FAKE_PDF),
      status: "unsupported",
      parser: null,
      documentId: null,
    });
    const blob = await corpus.resolveSource(join(root, "c", "blob.bin"));
    expect(blob?.status).toBe("unsupported");
    expect(Buffer.from((await corpus.readPayload(sha256(BLOB_BIN))) ?? [])).toEqual(
      Buffer.from(BLOB_BIN),
    );
    expect(existsSync(payloadFile(corpusDir, sha256(FAKE_PDF)))).toBe(true);
    expect(
      (await corpus.listDocuments()).some((document) => document.sourceUri === pdf?.sourceUri),
    ).toBe(false);
  });

  test("adding a parser adapter keeps the identity of every other source", async () => {
    const root = tempDir("root");
    writeFixture(root);
    const corpus = await open(tempDir("corpus"));
    await corpus.ingestFolder(root, { importedAt: IMPORTED_AT });
    const before = await corpus.listSources();

    const fakePdfAdapter: ParserAdapter = {
      id: "fake-pdf",
      supports: (relativePath) => relativePath.toLowerCase().endsWith(".pdf"),
      parse: ({ name, importedAt }) => ({
        title: name,
        sourceUri: name,
        html: "<p>Fake extracted walrus text.</p>",
        importedAt,
      }),
    };
    const report = await corpus.ingestFolder(root, {
      importedAt: LATER,
      parsers: [...DEFAULT_PARSER_ADAPTERS, fakePdfAdapter],
    });
    expect(report).toMatchObject({ files: 6, added: 0, updated: 1, unchanged: 5, unsupported: 1 });

    const after = await corpus.listSources();
    const pdfUri = uriOf(root, "c/report.pdf");
    expect(after.filter((source) => source.sourceUri !== pdfUri)).toEqual(
      before.filter((source) => source.sourceUri !== pdfUri),
    );
    const pdf = after.find((source) => source.sourceUri === pdfUri);
    expect(pdf).toMatchObject({
      sha256: sha256(FAKE_PDF),
      status: "parsed",
      parser: "fake-pdf",
      documentId: await filesystemDocumentId(pdfUri),
    });
    const pdfDocument = (await corpus.listDocuments()).find(
      (document) => document.sourceUri === pdfUri,
    );
    expect(pdfDocument?.id).toBe(await filesystemDocumentId(pdfUri));
    expect(pdfDocument?.text).toBe("Fake extracted walrus text.");
  });
});

describe("CLI companion", () => {
  function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(
      process.execPath,
      [join(REPO_ROOT, "src/filesystem/cli.ts"), ...args],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        timeout: 60_000,
      },
    );
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  test("package.json exposes the corpus script", () => {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(manifest.scripts.corpus).toBe("bun src/filesystem/cli.ts");
  });

  test("ingest, sources, rebuild-index and search work across processes", async () => {
    const root = tempDir("root");
    writeFixture(root);
    const corpusDir = tempDir("corpus");

    const ingest = runCli(["ingest", "--corpus", corpusDir, "--imported-at", IMPORTED_AT, root]);
    expect(ingest.status).toBe(0);
    expect(JSON.parse(ingest.stdout)).toEqual({
      root: resolve(root),
      files: 6,
      added: 6,
      updated: 0,
      unchanged: 0,
      removed: 0,
      // The CLI also runs the PDF text adapter (#22): the fake PDF is a malformed PDF, not an
      // unsupported file.
      unsupported: 1,
    });

    const sources = runCli(["sources", "--corpus", corpusDir]);
    expect(sources.status).toBe(0);
    expect(
      (JSON.parse(sources.stdout) as FilesystemSource[]).find((source) =>
        source.relativePath.endsWith("report.pdf"),
      ),
    ).toMatchObject({ status: "malformed", parser: "pdf-text", documentId: null });

    const rebuild = runCli(["rebuild-index", "--corpus", corpusDir]);
    expect(rebuild.status).toBe(0);
    expect(JSON.parse(rebuild.stdout)).toEqual({ documents: 4 });

    const search = runCli(["search", "--corpus", corpusDir, "lighthouse herring"]);
    expect(search.status).toBe(0);
    const cliResults = JSON.parse(search.stdout) as unknown;

    const corpus = await open(corpusDir);
    expect(JSON.parse(sources.stdout)).toEqual(
      JSON.parse(JSON.stringify(await corpus.listSources())),
    );
    expect(cliResults).toEqual(
      JSON.parse(
        JSON.stringify(
          await corpus.search({
            query: "lighthouse herring",
            topK: 10,
            mode: "hybrid",
            requireQuotedPhrases: true,
          }),
        ),
      ),
    );
  }, 120_000);

  test("usage errors exit non-zero", () => {
    expect(runCli(["ingest", tempDir("root")]).status).not.toBe(0);
    expect(runCli(["frobnicate", "--corpus", tempDir("corpus")]).status).not.toBe(0);
  }, 60_000);
});

/**
 * Acceptance tests for issue #22: extract and index embedded PDF text in filesystem corpora
 * with page provenance.
 *
 * These tests are the specification. They fail only because the PDF adapter and the
 * extensions below are missing; the fixture checks already pass. The #21 suite
 * (`filesystemCorpus.test.ts`, `filesystemCorpusReview.test.ts`) stays unchanged and must keep
 * passing.
 *
 * ## Fixtures (`src/test/fixtures/pdf/`)
 *
 * Synthetic PDFs written byte by byte by `generate.ts` (no PDF library): PDF 1.4, uncompressed
 * content streams, a correct xref table, Helvetica (standard Type1) with WinAnsiEncoding. Their
 * SHA-256 hashes are pinned below, and the expected text and pages are written here
 * independently of any extractor.
 *
 * ## Contract
 *
 * New module `src/filesystem/pdfAdapter.ts` (Bun only, like the rest of `src/filesystem`):
 *
 * ```ts
 * export interface PdfTextAdapterOptions {
 *   maxBytes?: number;  // larger files get status "limit-exceeded" (no extraction attempt needed)
 *   maxPages?: number;  // PDFs with more physical pages get status "limit-exceeded"
 * }
 * export const PDF_TEXT_DEFAULT_LIMITS: { maxBytes: number; maxPages: number }; // documented in README
 * export function createPdfTextAdapter(options?: PdfTextAdapterOptions): ParserAdapter;
 * ```
 *
 * The adapter has `id: "pdf-text"`, supports `*.pdf` case-insensitively and nothing else, and
 * sets `extractor` (below): `name` is the maintained extraction library, a package listed in
 * `package.json` `dependencies` and locked in `bun.lock`; `version` is its installed version;
 * `configuration` holds at least the effective `maxBytes` and `maxPages`. Two adapters created
 * with equal options have equal `extractor` values.
 *
 * Extensions of `src/filesystem/corpusStore.ts` (everything else as in #21):
 *
 * ```ts
 * export interface ParserAdapter {
 *   id: string;
 *   supports(relativePath: string): boolean;
 *   extractor?: ExtractorIdentity;          // new; part of the extraction reuse key
 *   parse(input: { name: string; bytes: Uint8Array; importedAt: string }):
 *     ParserResult | Promise<ParserResult>; // may now be async and return a richer result
 * }
 * // Suggested, not asserted: HtmlDocumentInput (the #21 text adapters, unchanged) |
 * //   { kind: "pages"; title: string; pageCount: number;
 * //     pages: Array<{ page: number; paragraphs: string[] }> } |
 * //   { kind: "outcome"; status: PdfFailureStatus; detail: string }
 *
 * export type PdfFailureStatus = "no-text" | "encrypted" | "malformed" | "limit-exceeded";
 * export interface FilesystemSource {
 *   ...#21 fields;
 *   status: "parsed" | "unsupported" | PdfFailureStatus;
 *   parser: string | null;      // "pdf-text" for PDF outcomes, also for failures
 *   documentId: string | null;  // null unless status === "parsed"
 *   detail?: string;            // non-empty human-readable reason, present exactly for failures
 * }
 * ```
 *
 * `IngestReport` keeps exactly its #21 fields (the #21 tests compare it with `toEqual`): a
 * failure is neither `unsupported` nor a document. Extensions of `src/domain/types.ts`:
 *
 * ```ts
 * export interface ExtractorIdentity {
 *   name: string;
 *   version: string;
 *   configuration: Record<string, string | number | boolean>;
 * }
 * ExtractedParagraph.page?: number;  // 1-based physical PDF page; absent for text imports
 * ExtractedDocument.asset?: {        // the binary original; absent for text imports
 *   mediaType: "application/pdf"; sha256: string; byteLength: number; pageCount: number;
 * };
 * ExtractedDocument.extractor?: ExtractorIdentity; // absent for text imports
 * SearchResultView.page?: number;    // page of the hit's paragraph; absent for text imports
 * ```
 *
 * Semantics:
 * - Physical pages are numbered from 1 in page-tree order and include empty pages; an empty
 *   page has no paragraph. Every paragraph lies on exactly one page; paragraph ordinals
 *   ascend with the page. Paragraph text is NFC; whitespace inside a page is not asserted
 *   beyond "collapsing runs of whitespace gives the page's lines joined by single spaces".
 *   `document.text` is the paragraphs joined by "\n\n" (the existing extraction invariant).
 *   `document.original` stays absent: PDF bytes never pass the text/HTML upload normalization.
 * - Isolation: a PDF that cannot be text-indexed gets its explicit status and `detail`, no
 *   document, and does not stop or roll back the rest of the ingest.
 *   `no-text`: no embedded text (scanned/image-only; OCR is future work). `encrypted`: the file
 *   needs a password. `malformed`: no parseable document structure. `limit-exceeded`: a
 *   configured `maxBytes`/`maxPages` limit was exceeded.
 * - Extraction reuse: the store calls `adapter.parse` at most once per (payload SHA-256, adapter
 *   id, `adapter.extractor`) that it has not already extracted, persisted across restarts, and
 *   failures are cached the same way. Identical bytes at other paths or roots reuse that
 *   extraction while each path keeps its own source and document. The store takes the
 *   extractor identity from the adapter object passed to `ingestFolder` (so a wrapper that only
 *   changes `extractor` changes the reuse key and the documents' `extractor`). A changed
 *   `extractor` counts as a changed parser: the source is `updated`, its text is re-derived and
 *   the index becomes stale. The tests count `parse` calls through a wrapping adapter; there is
 *   no timing.
 * - Search keeps going through `searchCorpus` (nlp-stack); `search` still equals
 *   `searchCorpus(await listDocuments(), request)`.
 * - corpus-core export of a PDF document (in `createCorpusCoreBatch`, so `exportCorpusCore` is
 *   still the shared export): asset `kind: "document"`, `content: { uri: sourceUri, hash: PDF
 *   SHA-256, media_type: "application/pdf", byte_length: PDF size }`, metadata `content_basis:
 *   "original"`; no payload line carries the PDF (payloads are text). The `extracted_text`
 *   representation keeps its text payload and its `extract_text` provenance from the asset,
 *   with `parameters_hash = sha256(canonicalJson(extractor.configuration))` and metadata
 *   `extractor_name`, `extractor_version`, `extractor_configuration` (canonical JSON: keys
 *   sorted). Segments stay one per paragraph with `character_range` in Unicode scalars of the
 *   representation text, `byte_range: null`, and `page_index = page - 1` (corpus-core page
 *   indexes are zero-based).
 *
 * Not decided here: whether `DEFAULT_PARSER_ADAPTERS` (and so the CLI) include the PDF
 * adapter. The #21 suite pins `DEFAULT_PARSER_ADAPTERS` to `["document-import"]` and a fake
 * `report.pdf` to `unsupported`, so these tests pass the parsers explicitly.
 */
import { afterEach, describe, expect, test } from "bun:test";
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
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { searchCorpus } from "../domain/search";
import type {
  ExtractedDocument,
  ExtractedParagraph,
  SearchRequestState,
  SearchResultView,
} from "../domain/types";
import {
  DOCUMENT_IMPORT_ADAPTER,
  openFilesystemCorpus,
  type FilesystemCorpus,
  type FilesystemSource,
  type ParserAdapter,
} from "../filesystem/corpusStore";
import {
  createCorpusCoreBatch,
  parseCorpusCoreBatch,
  serializeCorpusCoreBatch,
  type CorpusRecord,
} from "../storage/corpusCoreExport";
import { buildPdfFixtures } from "./fixtures/pdf/generate";

// ---------------------------------------------------------------------------------------------
// Contract types that do not exist yet (see the header).

interface ExtractorIdentity {
  name: string;
  version: string;
  configuration: Record<string, string | number | boolean>;
}

type PdfAdapter = ParserAdapter & { extractor: ExtractorIdentity };

interface PdfAdapterModule {
  PDF_TEXT_DEFAULT_LIMITS: { maxBytes: number; maxPages: number };
  createPdfTextAdapter(options?: { maxBytes?: number; maxPages?: number }): PdfAdapter;
}

type PdfParagraph = ExtractedParagraph & { page?: number };
type PdfDocument = Omit<ExtractedDocument, "paragraphs"> & {
  paragraphs: PdfParagraph[];
  asset?: { mediaType: string; sha256: string; byteLength: number; pageCount: number };
  extractor?: ExtractorIdentity;
};
type PdfHit = SearchResultView & { page?: number };
type PdfSource = Omit<FilesystemSource, "status"> & { status: string; detail?: string };

/** Loaded lazily so the fixture checks below run before the adapter exists. */
async function pdfModule(): Promise<PdfAdapterModule> {
  return (await import("../filesystem/pdfAdapter")) as unknown as PdfAdapterModule;
}

async function pdfAdapter(options?: { maxBytes?: number; maxPages?: number }) {
  return (await pdfModule()).createPdfTextAdapter(options);
}

// ---------------------------------------------------------------------------------------------
// Fixtures and their independently specified content.

const FIXTURE_DIR = join(import.meta.dir, "fixtures", "pdf");
const REPO_ROOT = resolve(import.meta.dir, "../..");

const FIXTURE_SHA256 = {
  "text-multipage.pdf": "9deb7b9509aead98d4a389a0ac9080a5627e94a8ad24a641387531bbb3ca1db8",
  "neighbour.pdf": "558ff6649a7ebab6b2895a2e1ff851be66b6e7e85044bf3ae9e156e4c32d7532",
  "over-limit.pdf": "51a469e779d3bbaf01d9a4ba10d6b73f32e9024ced939d5bb2a377c0cdbf36aa",
  "image-only.pdf": "aeee415beeeda16aabaa4526f81a41a25bb84710ff2fa24ff030eefb31f3544c",
  "encrypted.pdf": "57cf21607247047ddace52324a149b6b9f6790d3fe64668585107842ff6d5914",
  "malformed.pdf": "e3c0329ae1ce04c7fcc2510a58784d6fd77a7b194128efd07517d6013aab9230",
} as const;
type FixtureName = keyof typeof FIXTURE_SHA256;

/**
 * `text-multipage.pdf`: five physical pages, page 3 empty. "A marigold lantern hangs by the
 * door." repeats on pages 2 and 4; "velvet" ends page 4 and "thunderclap" starts page 5.
 */
const MULTIPAGE_PAGE_COUNT = 5;
const MULTIPAGE_PAGES = new Map<number, string>([
  [1, "Quarterly harbour ledger The quartzite pelican nests on the first page."],
  [2, "Café owners record the Größe of every loaf. A marigold lantern hangs by the door."],
  [
    4,
    "Late entries mention the obsidian walrus. A marigold lantern hangs by the door. The closing remark mentions velvet",
  ],
  [5, "thunderclap weather ends the ledger."],
]);
/** `neighbour.pdf`: one page. */
const NEIGHBOUR_TEXT = "The neighbouring kingfisher survives the bad files.";
/** `over-limit.pdf`: three pages, each mentioning "saffron". */
const OVER_LIMIT_PAGES = new Map<number, string>([
  [1, "Overflow ledger page one mentions saffron."],
  [2, "Overflow ledger page two mentions saffron."],
  [3, "Overflow ledger page three mentions saffron."],
]);
/** `encrypted.pdf` holds this sentence behind a user password. */
const ENCRYPTED_WORD = "password";

function fixture(name: FixtureName): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURE_DIR, name)));
}

const IMPORTED_AT = "2026-10-11T08:00:00.000Z";
const LATER = "2026-10-12T09:30:00.000Z";
const REVISION = "acceptance-rev";
const NOTES_MD = "# Bad file notes\n\nThe heron note stays searchable.\n";
const PAGE_HTML =
  "<html><head><title>Harbour page</title></head><body><h1>Harbour</h1><p>The lighthouse keeper counts herring boats.</p></body></html>";

// ---------------------------------------------------------------------------------------------
// Helpers.

const tempDirs: string[] = [];
const openCorpora: FilesystemCorpus[] = [];

function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `document-search-pdf-${label}-`));
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

function writeFile(root: string, relativePath: string, content: string | Uint8Array): string {
  const path = join(root, ...relativePath.split("/"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function canonicalJson(value: Record<string, string | number | boolean>): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    ),
  );
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function listPayloadFiles(corpusDir: string): string[] {
  const base = join(corpusDir, "payloads");
  if (!existsSync(base)) return [];
  return readdirSync(base, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}

/** Wraps an adapter and records the payload hash of every `parse` call (deterministic work log). */
function counting(adapter: ParserAdapter): { adapter: ParserAdapter; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    adapter: {
      id: adapter.id,
      extractor: (adapter as PdfAdapter).extractor,
      supports: (relativePath: string) => adapter.supports(relativePath),
      parse: (input) => {
        calls.push(sha256(input.bytes));
        return adapter.parse(input);
      },
    } as ParserAdapter,
  };
}

/** The same adapter under a different extractor identity (e.g. an upgraded library). */
function withExtractor(adapter: PdfAdapter, extractor: ExtractorIdentity): PdfAdapter {
  return {
    id: adapter.id,
    extractor,
    supports: (relativePath: string) => adapter.supports(relativePath),
    parse: (input) => adapter.parse(input),
  } as PdfAdapter;
}

async function documents(corpus: FilesystemCorpus): Promise<PdfDocument[]> {
  return (await corpus.listDocuments()) as unknown as PdfDocument[];
}

async function sourceAt(corpus: FilesystemCorpus, path: string): Promise<PdfSource | undefined> {
  return (await corpus.resolveSource(path)) as PdfSource | undefined;
}

function lexical(query: string): SearchRequestState {
  return { query, topK: 10, mode: "lexical", requireQuotedPhrases: true };
}

async function search(corpus: FilesystemCorpus, query: string): Promise<PdfHit[]> {
  return (await corpus.search(lexical(query))) as PdfHit[];
}

/** A hit is attributed to the document, its page, one of its paragraphs (segment) and a snippet. */
async function expectHitOn(
  corpus: FilesystemCorpus,
  hit: PdfHit | undefined,
  expected: { documentId: string; page: number; phrase: string },
): Promise<void> {
  expect(hit).toBeDefined();
  expect(hit?.documentId).toBe(expected.documentId);
  expect(hit?.page).toBe(expected.page);
  expect(hit?.chunkId).toBeTruthy();
  expect(hit?.snippet).toContain(expected.phrase);
  const document = (await documents(corpus)).find((entry) => entry.id === expected.documentId);
  const paragraph = document?.paragraphs.find((entry) => entry.ordinal === hit?.paragraphOrdinal);
  expect(paragraph?.page).toBe(expected.page);
  expect(paragraph?.text).toContain(expected.phrase);
}

/** One multi-page PDF next to a Markdown note, indexed with the PDF adapter. */
async function multipageCorpus(): Promise<{
  root: string;
  corpusDir: string;
  corpus: FilesystemCorpus;
  pdfPath: string;
  source: PdfSource;
}> {
  const root = tempDir("root");
  const pdfPath = writeFile(root, "reports/ledger.pdf", fixture("text-multipage.pdf"));
  writeFile(root, "notes/heron.md", NOTES_MD);
  const corpusDir = tempDir("corpus");
  const corpus = await open(corpusDir);
  await corpus.ingestFolder(root, {
    importedAt: IMPORTED_AT,
    parsers: [DOCUMENT_IMPORT_ADAPTER, await pdfAdapter()],
  });
  await corpus.rebuildSearchIndex();
  const source = await sourceAt(corpus, pdfPath);
  if (!source) throw new Error("ledger.pdf was not recorded");
  return { root, corpusDir, corpus, pdfPath, source };
}

// ---------------------------------------------------------------------------------------------

describe("fixtures", () => {
  test("committed PDFs are the generator output with pinned SHA-256 hashes", () => {
    const generated = buildPdfFixtures();
    expect(Object.keys(generated).sort()).toEqual(Object.keys(FIXTURE_SHA256).sort());
    for (const [name, hash] of Object.entries(FIXTURE_SHA256)) {
      const committed = fixture(name as FixtureName);
      expect(sha256(committed)).toBe(hash);
      expect(Buffer.from(committed).equals(Buffer.from(generated[name] ?? []))).toBe(true);
    }
  });

  test("fixtures have the intended structure", () => {
    const text = (name: FixtureName) => Buffer.from(fixture(name)).toString("latin1");
    for (const name of Object.keys(FIXTURE_SHA256) as FixtureName[]) {
      expect(text(name).startsWith("%PDF-1.4\n")).toBe(true);
      if (name !== "malformed.pdf") {
        expect(text(name).endsWith("%%EOF\n")).toBe(true);
        expect(text(name)).toContain("\nxref\n");
      }
    }
    expect(text("text-multipage.pdf")).toContain(`/Count ${MULTIPAGE_PAGE_COUNT}`);
    expect(text("text-multipage.pdf")).toContain("/Encoding /WinAnsiEncoding");
    expect(text("over-limit.pdf")).toContain("/Count 3");
    expect(text("image-only.pdf")).toContain("/Subtype /Image");
    expect(text("image-only.pdf")).not.toMatch(/\bTj\b|\/Font\b/);
    expect(text("encrypted.pdf")).toMatch(/\/Encrypt 6 0 R/);
    expect(text("encrypted.pdf")).toContain("/Filter /Standard");
    expect(text("malformed.pdf")).not.toMatch(/\/Catalog|\bxref\b|\btrailer\b|%%EOF/);
  });
});

describe("PDF text adapter", () => {
  test("handles .pdf files only and records its extractor identity and limits", async () => {
    const { PDF_TEXT_DEFAULT_LIMITS, createPdfTextAdapter } = await pdfModule();
    const adapter = createPdfTextAdapter();
    expect(adapter.id).toBe("pdf-text");
    expect(adapter.supports("reports/ledger.pdf")).toBe(true);
    expect(adapter.supports("reports/LEDGER.PDF")).toBe(true);
    expect(adapter.supports("notes/heron.md")).toBe(false);
    expect(adapter.supports("notes/page.html")).toBe(false);
    expect(adapter.supports("data/blob.bin")).toBe(false);

    expect(Number.isInteger(PDF_TEXT_DEFAULT_LIMITS.maxBytes)).toBe(true);
    expect(Number.isInteger(PDF_TEXT_DEFAULT_LIMITS.maxPages)).toBe(true);
    expect(PDF_TEXT_DEFAULT_LIMITS.maxBytes).toBeGreaterThan(0);
    expect(PDF_TEXT_DEFAULT_LIMITS.maxPages).toBeGreaterThan(0);
    expect(adapter.extractor.configuration).toMatchObject(PDF_TEXT_DEFAULT_LIMITS);
    expect(
      createPdfTextAdapter({ maxPages: 7, maxBytes: 4096 }).extractor.configuration,
    ).toMatchObject({ maxPages: 7, maxBytes: 4096 });
    // Deterministic identity: equal options give equal extractor records.
    expect(createPdfTextAdapter().extractor).toEqual(adapter.extractor);
    expect(createPdfTextAdapter({ maxPages: 7 }).extractor).not.toEqual(adapter.extractor);
  });

  test("the extraction library is a locked runtime dependency at the recorded version", async () => {
    const { name, version } = (await pdfAdapter()).extractor;
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies)).toContain(name);
    const installed = JSON.parse(
      readFileSync(join(REPO_ROOT, "node_modules", ...name.split("/"), "package.json"), "utf8"),
    ) as { version: string };
    expect(version).toBe(installed.version);
    expect(readFileSync(join(REPO_ROOT, "bun.lock"), "utf8")).toContain(`"${name}@${version}"`);
  });
});

describe("AC1/AC2: embedded text is searchable with page provenance through nlp-stack", () => {
  test("the multi-page PDF becomes one document with physical-page paragraphs", async () => {
    const { corpus, pdfPath, root, source } = await multipageCorpus();
    const adapter = await pdfAdapter();
    const sourceUri = pathToFileURL(pdfPath).href;
    const bytes = fixture("text-multipage.pdf");

    expect(source).toEqual({
      sourceUri,
      root: resolve(root),
      relativePath: "reports/ledger.pdf",
      sha256: FIXTURE_SHA256["text-multipage.pdf"],
      byteLength: bytes.byteLength,
      status: "parsed",
      parser: "pdf-text",
      documentId: source.documentId,
    });
    expect(source.documentId).toBeTruthy();
    // The original bytes stay content-addressed under their SHA-256 (#21).
    expect(
      Buffer.from((await corpus.readPayload(source.sha256)) ?? []).equals(Buffer.from(bytes)),
    ).toBe(true);

    const document = (await documents(corpus)).find((entry) => entry.sourceUri === sourceUri);
    expect(document?.id).toBe(source.documentId ?? "missing");
    expect(document?.title).toBeTruthy();
    expect(document?.original).toBeUndefined();
    expect(document?.asset).toEqual({
      mediaType: "application/pdf",
      sha256: FIXTURE_SHA256["text-multipage.pdf"],
      byteLength: bytes.byteLength,
      pageCount: MULTIPAGE_PAGE_COUNT,
    });
    expect(document?.extractor).toEqual(adapter.extractor);

    const paragraphs = document?.paragraphs ?? [];
    expect(paragraphs.map((paragraph) => paragraph.ordinal)).toEqual(
      paragraphs.map((_, index) => index),
    );
    const pages = paragraphs.map((paragraph) => paragraph.page ?? 0);
    expect(pages).toEqual([...pages].sort((left, right) => left - right));
    // The empty page 3 keeps its number but has no paragraph.
    expect([...new Set(pages)]).toEqual([1, 2, 4, 5]);
    for (const [page, text] of MULTIPAGE_PAGES) {
      const onPage = paragraphs.filter((paragraph) => paragraph.page === page);
      expect(collapse(onPage.map((paragraph) => paragraph.text).join(" "))).toBe(text);
    }
    for (const paragraph of paragraphs) {
      expect(paragraph.documentId).toBe(document?.id ?? "missing");
      expect(paragraph.text).toBe(paragraph.text.normalize("NFC"));
    }
    expect(document?.text).toBe(paragraphs.map((paragraph) => paragraph.text).join("\n\n"));
  });

  test("unique phrases on page 1 and on a later page are found on their pages", async () => {
    const { corpus, source } = await multipageCorpus();
    const documentId = source.documentId ?? "missing";

    const first = await search(corpus, '"quartzite pelican"');
    expect(first).toHaveLength(1);
    await expectHitOn(corpus, first[0], { documentId, page: 1, phrase: "quartzite pelican" });

    // Page 4 is the fourth physical page: the empty page 3 counts.
    const later = await search(corpus, '"obsidian walrus"');
    expect(later).toHaveLength(1);
    await expectHitOn(corpus, later[0], { documentId, page: 4, phrase: "obsidian walrus" });

    const last = await search(corpus, "thunderclap");
    expect(last).toHaveLength(1);
    await expectHitOn(corpus, last[0], { documentId, page: 5, phrase: "thunderclap" });

    // The hit's source and asset are the PDF path and its original bytes.
    const hitSource = (await corpus.listSources()).find(
      (entry) => entry.documentId === first[0]?.documentId,
    );
    expect(hitSource?.relativePath).toBe("reports/ledger.pdf");
    expect(hitSource?.sha256).toBe(FIXTURE_SHA256["text-multipage.pdf"]);

    // Ranking stays behind the shared nlp-stack boundary.
    expect(first).toEqual(
      (await searchCorpus(
        await corpus.listDocuments(),
        lexical('"quartzite pelican"'),
      )) as PdfHit[],
    );
  });

  test("embedded non-ASCII text is searchable on its page", async () => {
    const { corpus, source } = await multipageCorpus();
    const documentId = source.documentId ?? "missing";
    for (const word of ["Größe", "Café"]) {
      const hits = await search(corpus, word);
      expect(hits).toHaveLength(1);
      await expectHitOn(corpus, hits[0], { documentId, page: 2, phrase: word });
    }
    const phrase = await search(corpus, '"record the Größe"');
    expect(phrase).toHaveLength(1);
    await expectHitOn(corpus, phrase[0], { documentId, page: 2, phrase: "record the Größe" });
  });

  test("repeated text gives one hit per page with the right attribution", async () => {
    const { corpus, source } = await multipageCorpus();
    const documentId = source.documentId ?? "missing";
    const hits = await search(corpus, '"marigold lantern"');
    expect(hits).toHaveLength(2);
    expect(hits.map((hit) => hit.page).sort()).toEqual([2, 4]);
    for (const hit of hits) {
      await expectHitOn(corpus, hit, {
        documentId,
        page: hit.page ?? 0,
        phrase: "marigold lantern",
      });
    }
    expect(new Set(hits.map((hit) => hit.chunkId)).size).toBe(2);
  });

  test("a phrase split across a page break is not invented", async () => {
    const { corpus, source } = await multipageCorpus();
    const documentId = source.documentId ?? "missing";
    // Both halves are indexed, on their own pages ...
    const velvet = await search(corpus, "velvet");
    expect(velvet).toHaveLength(1);
    await expectHitOn(corpus, velvet[0], { documentId, page: 4, phrase: "velvet" });
    const thunder = await search(corpus, "thunderclap");
    expect(thunder).toHaveLength(1);
    await expectHitOn(corpus, thunder[0], { documentId, page: 5, phrase: "thunderclap" });
    // ... but the quoted cross-page phrase has no hit.
    expect(await search(corpus, '"velvet thunderclap"')).toEqual([]);
  });

  test("text documents next to the PDF keep their #21 behavior", async () => {
    const { corpus, root } = await multipageCorpus();
    const hits = await search(corpus, "heron");
    expect(hits).toHaveLength(1);
    const note = await sourceAt(corpus, join(root, "notes", "heron.md"));
    expect(note).toMatchObject({ status: "parsed", parser: "document-import" });
    expect(note?.detail).toBeUndefined();
    expect(hits[0]?.documentId).toBe(note?.documentId ?? "missing");
    expect(hits[0]?.page).toBeUndefined();
  });
});

describe("AC3: duplicate PDFs share one payload and one extraction", () => {
  test("nested duplicate paths and another root reuse the extraction; every alias is found", async () => {
    const root = tempDir("root");
    const paths = [
      writeFile(root, "reports/q3.pdf", fixture("text-multipage.pdf")),
      writeFile(root, "reports/archive/2026/q3-copy.pdf", fixture("text-multipage.pdf")),
    ];
    const otherRoot = tempDir("other-root");
    paths.push(writeFile(otherRoot, "mirror/deep/q3.pdf", fixture("text-multipage.pdf")));
    const corpusDir = tempDir("corpus");
    const corpus = await open(corpusDir);
    const { adapter, calls } = counting(await pdfAdapter());

    await corpus.ingestFolder(root, { importedAt: IMPORTED_AT, parsers: [adapter] });
    await corpus.ingestFolder(otherRoot, { importedAt: IMPORTED_AT, parsers: [adapter] });
    expect(calls).toEqual([FIXTURE_SHA256["text-multipage.pdf"]]);

    const hash = FIXTURE_SHA256["text-multipage.pdf"];
    expect(listPayloadFiles(corpusDir)).toEqual([hash]);
    const aliases = await Promise.all(paths.map((path) => sourceAt(corpus, path)));
    expect(aliases.map((alias) => alias?.sha256)).toEqual([hash, hash, hash]);
    expect(aliases.map((alias) => alias?.status)).toEqual(["parsed", "parsed", "parsed"]);
    const ids = aliases.map((alias) => alias?.documentId ?? "missing");
    expect(new Set(ids).size).toBe(3);

    // Each alias has its own document carrying the same derived text and pages.
    const stored = await documents(corpus);
    const pagesOf = (id: string) =>
      stored
        .find((document) => document.id === id)
        ?.paragraphs.map(({ ordinal, page, text }) => ({ ordinal, page, text }));
    expect(pagesOf(ids[1]!)).toEqual(pagesOf(ids[0]!));
    expect(pagesOf(ids[2]!)).toEqual(pagesOf(ids[0]!));
    for (const [index, id] of ids.entries()) {
      expect(stored.find((document) => document.id === id)?.sourceUri).toBe(
        pathToFileURL(paths[index]!).href,
      );
    }

    await corpus.rebuildSearchIndex();
    const hits = await search(corpus, '"obsidian walrus"');
    expect(new Set(hits.map((hit) => hit.documentId))).toEqual(new Set(ids));
    for (const hit of hits) {
      await expectHitOn(corpus, hit, {
        documentId: hit.documentId,
        page: 4,
        phrase: "obsidian walrus",
      });
    }
  });
});

describe("AC4: rescan, restart, rebuild and invalidation", () => {
  test("rescan, restart and index rebuild keep results and provenance without re-extracting", async () => {
    const root = tempDir("root");
    const pdfPath = writeFile(root, "reports/ledger.pdf", fixture("text-multipage.pdf"));
    writeFile(root, "notes/heron.md", NOTES_MD);
    const corpusDir = tempDir("corpus");
    const corpus = await open(corpusDir);
    const first = counting(await pdfAdapter());
    await corpus.ingestFolder(root, {
      importedAt: IMPORTED_AT,
      parsers: [DOCUMENT_IMPORT_ADAPTER, first.adapter],
    });
    expect(first.calls).toHaveLength(1);
    await corpus.rebuildSearchIndex();
    const queries = ['"quartzite pelican"', '"obsidian walrus"', '"marigold lantern"', "Größe"];
    const baseline = await Promise.all(queries.map((query) => search(corpus, query)));
    const documentsBefore = JSON.stringify(await corpus.listDocuments());
    const sourcesBefore = JSON.stringify(await corpus.listSources());
    const exportBefore = await corpus.exportCorpusCore(REVISION);

    // Unchanged rescan: no extraction, index stays current, identical results.
    const report = await corpus.ingestFolder(root, {
      importedAt: LATER,
      parsers: [DOCUMENT_IMPORT_ADAPTER, first.adapter],
    });
    expect(report).toMatchObject({ files: 2, added: 0, updated: 0, unchanged: 2, removed: 0 });
    expect(first.calls).toHaveLength(1);
    expect((await corpus.indexStatus()).state).toBe("current");
    expect(JSON.stringify(await corpus.listDocuments())).toBe(documentsBefore);
    expect(await Promise.all(queries.map((query) => search(corpus, query)))).toEqual(baseline);
    await closeCorpus(corpus);

    // Restart with a fresh adapter instance: still no extraction.
    const reopened = await open(corpusDir);
    const second = counting(await pdfAdapter());
    await reopened.ingestFolder(root, {
      importedAt: LATER,
      parsers: [DOCUMENT_IMPORT_ADAPTER, second.adapter],
    });
    expect(second.calls).toEqual([]);
    expect(JSON.stringify(await reopened.listSources())).toBe(sourcesBefore);
    expect(JSON.stringify(await reopened.listDocuments())).toBe(documentsBefore);

    // Deleting the derived index and rebuilding it restores the same results and pages.
    rmSync(join(corpusDir, "index"), { recursive: true, force: true });
    expect((await reopened.indexStatus()).state).toBe("missing");
    await reopened.rebuildSearchIndex();
    const rebuilt = await Promise.all(queries.map((query) => search(reopened, query)));
    expect(rebuilt).toEqual(baseline);
    expect(rebuilt[0]?.[0]?.page).toBe(1);
    expect(rebuilt[1]?.[0]?.page).toBe(4);
    expect(await reopened.exportCorpusCore(REVISION)).toBe(exportBefore);
    expect((await sourceAt(reopened, pdfPath))?.status).toBe("parsed");
  });

  test("changed bytes replace the derived text and remove stale hits", async () => {
    const { root, corpus, pdfPath, source } = await multipageCorpus();
    const { adapter, calls } = counting(await pdfAdapter());
    writeFile(root, "reports/ledger.pdf", fixture("neighbour.pdf"));

    const report = await corpus.ingestFolder(root, {
      importedAt: LATER,
      parsers: [DOCUMENT_IMPORT_ADAPTER, adapter],
    });
    expect(report).toMatchObject({ files: 2, updated: 1, unchanged: 1 });
    expect(calls).toEqual([FIXTURE_SHA256["neighbour.pdf"]]);
    const changed = await sourceAt(corpus, pdfPath);
    expect(changed?.sha256).toBe(FIXTURE_SHA256["neighbour.pdf"]);
    expect(changed?.documentId).toBe(source.documentId);

    const document = (await documents(corpus)).find((entry) => entry.id === source.documentId);
    expect(document?.asset?.sha256).toBe(FIXTURE_SHA256["neighbour.pdf"]);
    expect(document?.asset?.pageCount).toBe(1);
    expect(collapse(document?.text ?? "")).toBe(NEIGHBOUR_TEXT);
    expect(document?.importedAt).toBe(LATER);

    expect((await corpus.indexStatus()).state).toBe("stale");
    await corpus.rebuildSearchIndex();
    expect(await search(corpus, '"quartzite pelican"')).toEqual([]);
    expect(await search(corpus, "walrus")).toEqual([]);
    const fresh = await search(corpus, "kingfisher");
    expect(fresh).toHaveLength(1);
    await expectHitOn(corpus, fresh[0], {
      documentId: source.documentId ?? "missing",
      page: 1,
      phrase: "kingfisher",
    });
  });

  test("a changed extractor revision invalidates the derived extraction", async () => {
    const { root, corpus, source } = await multipageCorpus();
    const base = await pdfAdapter();
    const upgraded = withExtractor(base, {
      ...base.extractor,
      version: `${base.extractor.version}+acceptance-upgrade`,
    });
    const { adapter, calls } = counting(upgraded);

    const report = await corpus.ingestFolder(root, {
      importedAt: LATER,
      parsers: [DOCUMENT_IMPORT_ADAPTER, adapter],
    });
    expect(report).toMatchObject({ files: 2, updated: 1, unchanged: 1 });
    expect(calls).toEqual([FIXTURE_SHA256["text-multipage.pdf"]]);
    const document = (await documents(corpus)).find((entry) => entry.id === source.documentId);
    expect(document?.extractor).toEqual(upgraded.extractor);
    expect((await corpus.indexStatus()).state).toBe("stale");

    // The upgraded extraction is then reused like any other.
    await corpus.ingestFolder(root, {
      importedAt: LATER,
      parsers: [DOCUMENT_IMPORT_ADAPTER, adapter],
    });
    expect(calls).toHaveLength(1);
  });

  test("a changed extractor configuration invalidates the derived extraction", async () => {
    const { root, corpus, source } = await multipageCorpus();
    const { PDF_TEXT_DEFAULT_LIMITS } = await pdfModule();
    const reconfigured = await pdfAdapter({ maxPages: PDF_TEXT_DEFAULT_LIMITS.maxPages + 1 });
    const { adapter, calls } = counting(reconfigured);

    const report = await corpus.ingestFolder(root, {
      importedAt: LATER,
      parsers: [DOCUMENT_IMPORT_ADAPTER, adapter],
    });
    expect(report).toMatchObject({ updated: 1, unchanged: 1 });
    expect(calls).toEqual([FIXTURE_SHA256["text-multipage.pdf"]]);
    const document = (await documents(corpus)).find((entry) => entry.id === source.documentId);
    expect(document?.extractor?.configuration.maxPages).toBe(PDF_TEXT_DEFAULT_LIMITS.maxPages + 1);
    expect(document?.extractor).toEqual(reconfigured.extractor);
  });
});

describe("AC5: corpus-core export keeps the PDF asset, extractor provenance and pages", () => {
  test("export round trip retains asset hash, provenance, page locators and derived text", async () => {
    const { corpus, source } = await multipageCorpus();
    const adapter = await pdfAdapter();
    const exported = await corpus.exportCorpusCore(REVISION);
    // Still the shared export of the stored documents.
    expect(exported).toBe(
      serializeCorpusCoreBatch(await createCorpusCoreBatch(await corpus.listDocuments(), REVISION)),
    );

    const batch = parseCorpusCoreBatch(exported);
    expect(serializeCorpusCoreBatch(batch)).toBe(exported);
    const byType = <T extends CorpusRecord["record_type"]>(type: T) =>
      batch.records
        .filter(
          (record): record is Extract<CorpusRecord, { record_type: T }> =>
            record.record_type === type,
        )
        .map((record) => record.record);

    const pdfHash = FIXTURE_SHA256["text-multipage.pdf"];
    const asset = byType("asset").find((record) => record.content.uri === source.sourceUri);
    expect(asset).toBeDefined();
    expect(asset?.kind).toBe("document");
    expect(asset?.content).toEqual({
      uri: source.sourceUri,
      hash: pdfHash,
      media_type: "application/pdf",
      byte_length: fixture("text-multipage.pdf").byteLength,
    });
    expect(asset?.metadata.content_basis).toBe("original");
    // The binary PDF is not smuggled into a text payload.
    expect(batch.payloads.some((payload) => payload.hash === pdfHash)).toBe(false);

    const representation = byType("representation").find(
      (record) => record.owner.record_type === "asset" && record.owner.id === asset?.id,
    );
    expect(representation?.kind).toBe("extracted_text");
    const configuration = canonicalJson(adapter.extractor.configuration);
    expect(representation?.metadata).toMatchObject({
      extractor_name: adapter.extractor.name,
      extractor_version: adapter.extractor.version,
      extractor_configuration: configuration,
    });
    expect(representation?.provenance).toMatchObject({
      operation: "extract_text",
      inputs: [{ record_type: "asset", id: asset?.id }],
      parameters_hash: sha256(configuration),
    });
    const payload = batch.payloads.find((entry) => entry.hash === representation?.content_hash);
    const document = (await documents(corpus)).find((entry) => entry.id === source.documentId);
    expect(payload?.text).toBe(document?.text ?? "missing");
    expect(payload?.hash).toBe(sha256(document?.text ?? ""));

    // One segment per paragraph; offsets address the derived text, pages are zero-based indexes.
    const scalars = Array.from(payload?.text ?? "");
    const segments = byType("segment")
      .filter((record) => record.asset_id === asset?.id)
      .sort(
        (left, right) =>
          Number(left.metadata.paragraph_ordinal) - Number(right.metadata.paragraph_ordinal),
      );
    expect(segments).toHaveLength(document?.paragraphs.length ?? -1);
    for (const segment of segments) {
      const paragraph = document?.paragraphs.find(
        (entry) => String(entry.ordinal) === segment.metadata.paragraph_ordinal,
      );
      expect(segment.locator.byte_range).toBeNull();
      expect(segment.locator.page_index).toBe((paragraph?.page ?? 0) - 1);
      expect(segment.locator.selectors).toMatchObject({
        character_unit: "unicode_scalar",
        representation_id: representation?.id,
      });
      const range = segment.locator.character_range;
      expect(scalars.slice(range?.start ?? 0, range?.end ?? 0).join("")).toBe(
        paragraph?.text ?? "missing",
      );
    }
    const pageIndexOf = (phrase: string) =>
      segments.find((segment) => {
        const range = segment.locator.character_range;
        return scalars
          .slice(range?.start ?? 0, range?.end ?? 0)
          .join("")
          .includes(phrase);
      })?.locator.page_index;
    expect(pageIndexOf("quartzite pelican")).toBe(0);
    expect(pageIndexOf("Größe")).toBe(1);
    expect(pageIndexOf("obsidian walrus")).toBe(3);
    expect(pageIndexOf("thunderclap")).toBe(4);
    expect(segments.some((segment) => segment.locator.page_index === 2)).toBe(false);
  });
});

describe("AC6: files that cannot be text-indexed get explicit outcomes and are isolated", () => {
  async function badFolder(): Promise<{
    root: string;
    corpusDir: string;
    corpus: FilesystemCorpus;
    calls: string[];
    parsers: ParserAdapter[];
  }> {
    const root = tempDir("root");
    writeFile(root, "bad/encrypted.pdf", fixture("encrypted.pdf"));
    writeFile(root, "bad/image-only.pdf", fixture("image-only.pdf"));
    writeFile(root, "bad/malformed.pdf", fixture("malformed.pdf"));
    writeFile(root, "bad/over-limit.pdf", fixture("over-limit.pdf"));
    writeFile(root, "good/neighbour.pdf", fixture("neighbour.pdf"));
    writeFile(root, "good/notes.md", NOTES_MD);
    const corpusDir = tempDir("corpus");
    const corpus = await open(corpusDir);
    const { adapter, calls } = counting(await pdfAdapter({ maxPages: 2 }));
    const parsers = [DOCUMENT_IMPORT_ADAPTER, adapter];
    const report = await corpus.ingestFolder(root, { importedAt: IMPORTED_AT, parsers });
    expect(report).toEqual({
      root: resolve(root),
      files: 6,
      added: 6,
      updated: 0,
      unchanged: 0,
      removed: 0,
      unsupported: 0,
    });
    return { root, corpusDir, corpus, calls, parsers };
  }

  const EXPECTED_STATUS: Array<[string, FixtureName, string]> = [
    ["bad/encrypted.pdf", "encrypted.pdf", "encrypted"],
    ["bad/image-only.pdf", "image-only.pdf", "no-text"],
    ["bad/malformed.pdf", "malformed.pdf", "malformed"],
    ["bad/over-limit.pdf", "over-limit.pdf", "limit-exceeded"],
  ];

  test("each bad PDF has its outcome and no document; the neighbours are indexed", async () => {
    const { root, corpus, calls } = await badFolder();
    expect(calls).toHaveLength(5);

    for (const [relativePath, name, status] of EXPECTED_STATUS) {
      const source = await sourceAt(corpus, join(root, ...relativePath.split("/")));
      expect(source).toEqual({
        sourceUri: pathToFileURL(join(root, ...relativePath.split("/"))).href,
        root: resolve(root),
        relativePath,
        sha256: FIXTURE_SHA256[name],
        byteLength: fixture(name).byteLength,
        status,
        parser: "pdf-text",
        documentId: null,
        detail: expect.any(String),
      });
      expect(source?.detail?.trim()).not.toBe("");
      // The original bytes are still kept for a later extractor (e.g. OCR).
      expect(
        Buffer.from((await corpus.readPayload(FIXTURE_SHA256[name])) ?? []).equals(
          Buffer.from(fixture(name)),
        ),
      ).toBe(true);
    }

    const neighbour = await sourceAt(corpus, join(root, "good", "neighbour.pdf"));
    expect(neighbour).toMatchObject({ status: "parsed", parser: "pdf-text" });
    expect(neighbour?.detail).toBeUndefined();
    const stored = await documents(corpus);
    expect(stored.map((document) => document.sourceUri).sort()).toEqual(
      [
        pathToFileURL(join(root, "good", "neighbour.pdf")).href,
        pathToFileURL(join(root, "good", "notes.md")).href,
      ].sort(),
    );

    // Failures are not counted as text-indexed.
    expect(await corpus.rebuildSearchIndex()).toEqual({ documents: 2 });
    const kingfisher = await search(corpus, "kingfisher");
    expect(kingfisher).toHaveLength(1);
    await expectHitOn(corpus, kingfisher[0], {
      documentId: neighbour?.documentId ?? "missing",
      page: 1,
      phrase: "kingfisher",
    });
    expect(await search(corpus, "heron")).toHaveLength(1);
    expect(await search(corpus, "saffron")).toEqual([]);
    expect(await search(corpus, ENCRYPTED_WORD)).toEqual([]);
  });

  test("outcomes are cached across rescans and restarts", async () => {
    const { root, corpusDir, corpus, calls, parsers } = await badFolder();
    const before = JSON.stringify(await corpus.listSources());
    const report = await corpus.ingestFolder(root, { importedAt: LATER, parsers });
    expect(report).toMatchObject({ files: 6, unchanged: 6, updated: 0 });
    expect(calls).toHaveLength(5);
    await closeCorpus(corpus);

    const reopened = await open(corpusDir);
    expect(JSON.stringify(await reopened.listSources())).toBe(before);
    await reopened.ingestFolder(root, { importedAt: LATER, parsers });
    expect(calls).toHaveLength(5);
    expect(JSON.stringify(await reopened.listSources())).toBe(before);
  });

  test("the page limit is configurable: within the default limits the file is indexed", async () => {
    const { root, corpus } = await badFolder();
    const { adapter, calls } = counting(await pdfAdapter());
    await corpus.ingestFolder(root, {
      importedAt: LATER,
      parsers: [DOCUMENT_IMPORT_ADAPTER, adapter],
    });
    // The changed configuration re-extracts every PDF once.
    expect(calls).toHaveLength(5);
    const overLimit = await sourceAt(corpus, join(root, "bad", "over-limit.pdf"));
    expect(overLimit?.status).toBe("parsed");
    expect(overLimit?.detail).toBeUndefined();
    const document = (await documents(corpus)).find((entry) => entry.id === overLimit?.documentId);
    expect(document?.asset?.pageCount).toBe(3);
    for (const [page, text] of OVER_LIMIT_PAGES) {
      const onPage = document?.paragraphs.filter((paragraph) => paragraph.page === page) ?? [];
      expect(collapse(onPage.map((paragraph) => paragraph.text).join(" "))).toBe(text);
    }
    // The other outcomes do not depend on the page limit.
    for (const [relativePath, , status] of EXPECTED_STATUS.slice(0, 3)) {
      expect((await sourceAt(corpus, join(root, ...relativePath.split("/"))))?.status).toBe(status);
    }

    await corpus.rebuildSearchIndex();
    const hits = await search(corpus, '"page three mentions saffron"');
    expect(hits).toHaveLength(1);
    await expectHitOn(corpus, hits[0], {
      documentId: overLimit?.documentId ?? "missing",
      page: 3,
      phrase: "page three mentions saffron",
    });
  });

  test("the byte limit is configurable", async () => {
    const root = tempDir("root");
    const path = writeFile(root, "good/neighbour.pdf", fixture("neighbour.pdf"));
    const corpus = await open(tempDir("corpus"));
    const tooSmall = fixture("neighbour.pdf").byteLength - 1;
    await corpus.ingestFolder(root, {
      importedAt: IMPORTED_AT,
      parsers: [await pdfAdapter({ maxBytes: tooSmall })],
    });
    expect(await sourceAt(corpus, path)).toMatchObject({
      status: "limit-exceeded",
      parser: "pdf-text",
      documentId: null,
    });
    expect(await corpus.listDocuments()).toEqual([]);

    await corpus.ingestFolder(root, {
      importedAt: LATER,
      parsers: [await pdfAdapter({ maxBytes: tooSmall + 1 })],
    });
    expect((await sourceAt(corpus, path))?.status).toBe("parsed");
  });
});

describe("AC7: existing text formats and documentation", () => {
  test("HTML, Markdown and plain-text documents are unchanged by the PDF adapter", async () => {
    const root = tempDir("root");
    writeFile(root, "a/notes.md", NOTES_MD);
    writeFile(root, "a/page.html", PAGE_HTML);
    writeFile(root, "a/plain.txt", "Pantry inventory lists barley and lentils.\n");
    writeFile(root, "b/ledger.pdf", fixture("text-multipage.pdf"));
    const withoutPdf = await open(tempDir("corpus-a"));
    const withPdf = await open(tempDir("corpus-b"));
    await withoutPdf.ingestFolder(root, { importedAt: IMPORTED_AT });
    await withPdf.ingestFolder(root, {
      importedAt: IMPORTED_AT,
      parsers: [DOCUMENT_IMPORT_ADAPTER, await pdfAdapter()],
    });

    const isText = (uri: string | undefined) => !uri?.endsWith(".pdf");
    const textDocuments = (await withPdf.listDocuments()).filter((document) =>
      isText(document.sourceUri),
    );
    expect(textDocuments).toHaveLength(3);
    expect(textDocuments).toEqual(
      (await withoutPdf.listDocuments()).filter((document) => isText(document.sourceUri)),
    );
    for (const document of textDocuments as PdfDocument[]) {
      expect(document.asset).toBeUndefined();
      expect(document.extractor).toBeUndefined();
      expect(document.paragraphs.every((paragraph) => paragraph.page === undefined)).toBe(true);
    }
    expect((await withPdf.listSources()).filter((source) => isText(source.sourceUri))).toEqual(
      (await withoutPdf.listSources()).filter((source) => isText(source.sourceUri)),
    );
  });

  test("README documents embedded PDF text support and OCR as future work", () => {
    const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
    expect(readme).toMatch(/embedded\s+PDF\s+text/i);
    expect(readme).toMatch(/scanned\s+PDFs?\b[^.]*\bOCR\b/i);
    expect(readme).not.toMatch(/PDF\s+extraction\s+is\s+not\s+implemented/i);
  });
});

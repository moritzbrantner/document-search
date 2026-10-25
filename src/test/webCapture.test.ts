/**
 * Issue #20: reproducible WARC-backed web capture ingestion for the filesystem corpus.
 * Every test runs against a local deterministic HTTP server; none needs the public internet.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

import {
  openFilesystemCorpus,
  WEB_CAPTURE_EXTRACTOR,
  type FilesystemCorpus,
} from "../filesystem/corpusStore";
import { headerValue, parseWarc, REVISIT_PROFILE, splitHttpBlock } from "../filesystem/warc";
import { WEB_CAPTURE_PRODUCER, WEB_CAPTURE_VERSION } from "../filesystem/webCapture";
import {
  parseCorpusCoreBatch,
  type CorpusAsset,
  type CorpusRepresentation,
  type CorpusSource,
} from "../storage/corpusCoreExport";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const PAGE_V1 =
  "<html><head><title>Harbour notes</title></head><body><h1>Harbour</h1><p>The lighthouse keeper counts herring boats.</p></body></html>";
const PAGE_V2 =
  "<html><head><title>Harbour notes</title></head><body><p>The page now talks about zeppelins.</p></body></html>";
const GZIP_PAGE =
  "<html><head><title>Packed</title></head><body><p>Compressed barley.</p></body></html>";
const BINARY = new Uint8Array([0, 255, 1, 254, 0x80]);

let server: Server;
let base: string;
let page = PAGE_V1;
const tempDirs: string[] = [];
const corpora: FilesystemCorpus[] = [];

function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function clock(start = Date.parse("2026-10-25T10:00:00.000Z")): () => string {
  let tick = 0;
  return () => new Date(start + 1000 * tick++).toISOString();
}

async function openCorpus(): Promise<{ corpus: FilesystemCorpus; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "document-search-capture-"));
  tempDirs.push(dir);
  const corpus = await openFilesystemCorpus(dir);
  corpora.push(corpus);
  return { corpus, dir };
}

beforeEach(async () => {
  page = PAGE_V1;
  server = createServer((request, response) => {
    switch (request.url) {
      case "/old":
        response.writeHead(301, { Location: "/moved" }).end("gone");
        return;
      case "/moved":
        response.writeHead(302, { Location: `${base}/page` }).end();
        return;
      case "/page":
      case "/mirror":
        response
          .writeHead(200, { "Content-Type": "text/html; charset=utf-8", ETag: `"${sha256(page)}"` })
          .end(page);
        return;
      case "/gz":
        response
          .writeHead(200, { "Content-Type": "text/html", "Content-Encoding": "gzip" })
          .end(gzipSync(GZIP_PAGE));
        return;
      case "/data.bin":
        response.writeHead(200, { "Content-Type": "application/octet-stream" }).end(BINARY);
        return;
      default:
        response.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no server port");
  base = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  for (const corpus of corpora.splice(0)) corpus.close();
  await new Promise<void>((done) => server.close(() => done()));
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("web capture", () => {
  test("records the redirect chain and stores the final response in a WARC 1.1 file", async () => {
    const { corpus, dir } = await openCorpus();
    const report = await corpus.captureUrls([`${base}/old`], { now: clock() });
    expect(report.failed).toEqual([]);
    const [capture] = report.captures;
    if (!capture) throw new Error("no capture");

    expect(capture.requestedUrl).toBe(`${base}/old`);
    expect(capture.finalUrl).toBe(`${base}/page`);
    expect(capture.redirectChain.map((hop) => [hop.url, hop.status, hop.location])).toEqual([
      [`${base}/old`, 301, "/moved"],
      [`${base}/moved`, 302, `${base}/page`],
      [`${base}/page`, 200, null],
    ]);
    expect(capture.retrievedAt).toBe("2026-10-25T10:00:02.000Z");
    expect(capture.status).toBe(200);
    expect(capture.mediaType).toBe("text/html");
    expect(capture.charset).toBe("utf-8");
    expect(capture.payloadSha256).toBe(sha256(PAGE_V1));
    expect(capture.producer).toEqual({ name: WEB_CAPTURE_PRODUCER, version: WEB_CAPTURE_VERSION });
    expect(capture.extraction).toEqual({
      status: "parsed",
      extractor: WEB_CAPTURE_EXTRACTOR,
      reason: null,
    });

    const warcBytes = readFileSync(join(dir, capture.warc.path));
    expect(sha256(warcBytes)).toBe(capture.warc.sha256);
    const records = parseWarc(new Uint8Array(warcBytes));
    expect(records.map((record) => headerValue(record.headers, "WARC-Type"))).toEqual([
      "warcinfo",
      "request",
      "response",
      "request",
      "response",
      "request",
      "response",
    ]);
    const final = records.at(-1)!;
    expect(headerValue(final.headers, "WARC-Record-ID")).toBe(capture.warc.responseRecordId);
    expect(headerValue(final.headers, "WARC-Target-URI")).toBe(`${base}/page`);
    expect(headerValue(final.headers, "WARC-Payload-Digest")).toBe(`sha256:${sha256(PAGE_V1)}`);
    const http = splitHttpBlock(final.block);
    expect(http.startLine).toBe("HTTP/1.1 200 OK");
    expect(new TextDecoder().decode(http.body)).toBe(PAGE_V1);
    expect(headerValue(http.headers, "content-type")).toBe("text/html; charset=utf-8");
    const firstRequest = splitHttpBlock(records[1]!.block);
    expect(firstRequest.startLine).toBe("GET /old HTTP/1.1");

    const [document] = await corpus.listDocuments();
    expect(document?.id).toBe(capture.documentId!);
    expect(document?.title).toBe("Harbour notes");
    expect(document?.sourceUri).toBe(`${base}/page`);
    expect(document?.importedAt).toBe(capture.retrievedAt);
    expect(await corpus.listSources()).toEqual([]);
  });

  test("a capture stays inspectable from its exact stored bytes after the live page changes", async () => {
    const { corpus } = await openCorpus();
    const now = clock();
    const first = (await corpus.captureUrls([`${base}/page`], { now })).captures[0]!;
    page = PAGE_V2;
    const second = (await corpus.captureUrls([`${base}/page`], { now })).captures[0]!;

    expect(second.captureId).not.toBe(first.captureId);
    expect(second.payloadSha256).toBe(sha256(PAGE_V2));
    expect(new TextDecoder().decode(await corpus.readCapturePayload(first.captureId))).toBe(
      PAGE_V1,
    );
    expect(new TextDecoder().decode(await corpus.readCapturePayload(second.captureId))).toBe(
      PAGE_V2,
    );
    expect((await corpus.listCaptures()).map((capture) => capture.captureId)).toEqual([
      first.captureId,
      second.captureId,
    ]);
  });

  test("duplicate payloads are stored once but keep separate capture and source records", async () => {
    const { corpus, dir } = await openCorpus();
    const report = await corpus.captureUrls([`${base}/page`, `${base}/mirror`], { now: clock() });
    const [page1, mirror] = report.captures;
    if (!page1 || !mirror) throw new Error("missing captures");

    expect(mirror.payloadSha256).toBe(page1.payloadSha256);
    expect(mirror.captureId).not.toBe(page1.captureId);
    expect(mirror.documentId).not.toBe(page1.documentId);
    expect(page1.warc.revisitOf).toBeNull();
    expect(mirror.warc.revisitOf).toBe(page1.warc.responseRecordId);

    const database = new Database(join(dir, "corpus.sqlite"), { readonly: true });
    try {
      expect(
        database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM payloads").get()
          ?.count,
      ).toBe(1);
    } finally {
      database.close();
    }

    const revisit = parseWarc(new Uint8Array(readFileSync(join(dir, mirror.warc.path)))).at(-1)!;
    expect(headerValue(revisit.headers, "WARC-Type")).toBe("revisit");
    expect(headerValue(revisit.headers, "WARC-Profile")).toBe(REVISIT_PROFILE);
    expect(headerValue(revisit.headers, "WARC-Refers-To")).toBe(page1.warc.responseRecordId);
    expect(headerValue(revisit.headers, "WARC-Refers-To-Target-URI")).toBe(`${base}/page`);
    expect(splitHttpBlock(revisit.block).body.byteLength).toBe(0);
    expect(await corpus.readCapturePayload(mirror.captureId)).toEqual(
      new TextEncoder().encode(PAGE_V1),
    );

    const batch = parseCorpusCoreBatch(await corpus.exportCorpusCore("test-rev"));
    const sources = batch.records.flatMap((entry) =>
      entry.record_type === "source" ? [entry.record as CorpusSource] : [],
    );
    const assets = batch.records.flatMap((entry) =>
      entry.record_type === "asset" ? [entry.record as CorpusAsset] : [],
    );
    expect(sources.map((source) => source.uri).sort()).toEqual([`${base}/mirror`, `${base}/page`]);
    expect(new Set(sources.map((source) => source.id)).size).toBe(2);
    expect(assets.map((asset) => asset.content.hash)).toEqual([sha256(PAGE_V1), sha256(PAGE_V1)]);
    expect(batch.payloads.filter((payload) => payload.hash === sha256(PAGE_V1))).toHaveLength(1);
  });

  test("corpus-core export keeps HTTP provenance apart from the extracted text", async () => {
    const { corpus } = await openCorpus();
    const capture = (await corpus.captureUrls([`${base}/old`], { now: clock() })).captures[0]!;
    const batch = parseCorpusCoreBatch(await corpus.exportCorpusCore("test-rev"));

    const source = batch.records.find((entry) => entry.record_type === "source")
      ?.record as CorpusSource;
    expect(source.kind).toBe("url");
    expect(source.uri).toBe(`${base}/old`);
    expect(source.metadata.final_url).toBe(`${base}/page`);
    expect(source.metadata.retrieved_at).toBe(capture.retrievedAt);
    expect(source.metadata.http_status).toBe("200");
    expect(source.metadata.capture_producer).toBe(WEB_CAPTURE_PRODUCER);
    expect(JSON.parse(source.metadata.redirect_chain!)).toEqual(capture.redirectChain);

    const asset = batch.records.find((entry) => entry.record_type === "asset")
      ?.record as CorpusAsset;
    expect(asset.content).toEqual({
      uri: `${base}/page`,
      hash: sha256(PAGE_V1),
      media_type: "text/html; charset=utf-8",
      byte_length: new TextEncoder().encode(PAGE_V1).byteLength,
    });
    expect(asset.metadata.content_basis).toBe("http_payload");
    expect(asset.metadata.warc_record_id).toBe(capture.warc.responseRecordId);

    const representation = batch.records.find((entry) => entry.record_type === "representation")
      ?.record as CorpusRepresentation;
    expect(representation.owner).toEqual({ record_type: "asset", id: asset.id });
    expect(representation.kind).toBe("extracted_text");
    expect(representation.content_hash).not.toBe(asset.content.hash);
    expect(representation.provenance.inputs).toEqual([{ record_type: "asset", id: asset.id }]);
    expect(representation.metadata.extractor).toBe(WEB_CAPTURE_EXTRACTOR);
    expect(representation.metadata.final_url).toBeUndefined();
  });

  test("content-coded payloads keep their exact bytes and still yield text", async () => {
    const { corpus } = await openCorpus();
    const capture = (await corpus.captureUrls([`${base}/gz`], { now: clock() })).captures[0]!;
    const stored = await corpus.readCapturePayload(capture.captureId);
    expect(stored?.slice(0, 2)).toEqual(new Uint8Array([0x1f, 0x8b]));
    expect(capture.contentEncoding).toBe("gzip");
    const [document] = await corpus.listDocuments();
    expect(document?.text).toContain("Compressed barley.");
    expect(document?.original).toBeUndefined();
  });

  test("non-text and error responses are captured without a document", async () => {
    const { corpus } = await openCorpus();
    const report = await corpus.captureUrls([`${base}/data.bin`, `${base}/missing`], {
      now: clock(),
    });
    expect(report.captures.map((capture) => [capture.status, capture.extraction.status])).toEqual([
      [200, "unsupported"],
      [404, "unsupported"],
    ]);
    expect(await corpus.readCapturePayload(report.captures[0]!.captureId)).toEqual(BINARY);
    expect(await corpus.listDocuments()).toEqual([]);

    const batch = parseCorpusCoreBatch(await corpus.exportCorpusCore("test-rev"));
    expect(batch.records.map((entry) => entry.record_type)).toEqual([
      "source",
      "asset",
      "source",
      "asset",
    ]);
  });

  test("unreachable URLs are reported, not stored", async () => {
    const { corpus } = await openCorpus();
    const report = await corpus.captureUrls(["ftp://example.invalid/x", "not a url"]);
    expect(report.captures).toEqual([]);
    expect(report.failed.map((failure) => failure.url)).toEqual([
      "ftp://example.invalid/x",
      "not a url",
    ]);
    expect(await corpus.listCaptures()).toEqual([]);
  });

  test("search over captured pages stays local once the server is gone", async () => {
    const { corpus } = await openCorpus();
    await corpus.captureUrls([`${base}/page`], { now: clock() });
    await corpus.rebuildSearchIndex();
    await new Promise<void>((done) => server.close(() => done()));
    server = createServer();
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));

    const results = await corpus.search({
      query: "lighthouse",
      topK: 5,
      mode: "lexical",
      requireQuotedPhrases: true,
    });
    expect(results[0]?.documentTitle).toBe("Harbour notes");
  });

  test("an existing schema-1 corpus is migrated in place", async () => {
    const { corpus, dir } = await openCorpus();
    corpus.close();
    corpora.splice(corpora.indexOf(corpus), 1);
    const database = new Database(join(dir, "corpus.sqlite"));
    database.run("DROP TABLE captures");
    database.run("PRAGMA user_version = 1");
    database.close();

    const reopened = await openFilesystemCorpus(dir);
    corpora.push(reopened);
    const report = await reopened.captureUrls([`${base}/page`], { now: clock() });
    expect(report.captures).toHaveLength(1);
  });

  test("CLI captures a URL list and writes the exact payload back out", async () => {
    const { dir } = await openCorpus();
    const list = join(dir, "urls.txt");
    writeFileSync(list, `# sources\n${base}/old\n\n${base}/mirror\n`);
    const capture = await runCli(["capture", "--corpus", dir, "--url-list", list]);
    expect(capture.exitCode).toBe(0);
    const report = JSON.parse(capture.stdout) as {
      captures: { captureId: string; finalUrl: string }[];
    };
    expect(report.captures.map((entry) => entry.finalUrl)).toEqual([
      `${base}/page`,
      `${base}/mirror`,
    ]);

    const listed = await runCli(["captures", "--corpus", dir]);
    expect(JSON.parse(listed.stdout)).toHaveLength(2);

    const out = join(dir, "payload.html");
    const written = await runCli([
      "capture-payload",
      "--corpus",
      dir,
      "--out",
      out,
      report.captures[0]!.captureId,
    ]);
    expect(written.exitCode).toBe(0);
    expect(readFileSync(out, "utf8")).toBe(PAGE_V1);
    expect(existsSync(join(dir, "warc"))).toBe(true);

    const failing = await runCli(["capture", "--corpus", dir, "ftp://example.invalid/x"]);
    expect(failing.exitCode).toBe(1);
    expect(JSON.parse(failing.stdout).failed).toHaveLength(1);
  });
});

async function runCli(args: string[]): Promise<{ exitCode: number; stdout: string }> {
  // Async spawn: the fixture server runs in this process and must keep answering.
  const child = Bun.spawn(["bun", "src/filesystem/cli.ts", ...args], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return { exitCode, stdout };
}

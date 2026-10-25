# Document Search

Local-first document search app built with Bun, Vite, React, TypeScript,
IndexedDB, and the `text-core-wasm` and `text-index-wasm` packages of
`nlp-stack`, consumed from the commit-pinned git package
[`moritzbrantner/nlp-stack-wasm`](https://github.com/moritzbrantner/nlp-stack-wasm).
A clean clone of this repository is all that is needed.

The GitHub Pages build is a usable browser demo. A fresh browser corpus starts
with five deterministic demo documents, and users can add their own HTML,
Markdown, or plain-text files. Uploaded files are parsed in the browser, stored
in IndexedDB, and included in subsequent searches without sending the corpus to
a hosted search service.

## Setup

```bash
bun install
bun dev
```

`bun install` builds the WASM packages of `@moritzbrantner/nlp-stack-wasm` from
the nlp-stack commit that package pins (its `prepare` script, enabled through
`trustedDependencies`). That needs `git`, `rustup` (the pinned Rust toolchain
and the `wasm32-unknown-unknown` target are installed on first use) and
`wasm-pack` (installed into `~/.cache/nlp-stack-wasm` when it is not on `PATH`).
To move to a newer nlp-stack revision, update the `#<commit>` of
`@moritzbrantner/nlp-stack-wasm` in `package.json` to a newer commit of that
repository and run `bun install`. Then set the `nlp-stack-wasm` `rev` in
`.coding-tooling.source-deps.json` to that commit and its `nlp-stack` upstream
`rev` to that commit's `nlpStack.commit`, so source mode stays on the same
revisions.

To develop against local checkouts instead, keep `nlp-stack-wasm` and
`nlp-stack` next to this repository at the revisions declared in
`.coding-tooling.source-deps.json` and run `bash scripts/source-deps activate`
(needs [coding-tooling](https://github.com/moritzbrantner/coding-tooling) on
`PATH` or a sibling checkout). It builds the WASM wrapper from the local
`nlp-stack` checkout through `NLP_STACK_SOURCE_DIR`; `bash scripts/source-deps
status` shows the active revisions and `bash scripts/source-deps deactivate`
restores the ordinary install.

`.repository.toml` is the machine-readable repository contract: this repository
owns the corpus and UI, `nlp-stack` owns text extraction, indexing and retrieval
semantics. `coding-tooling repository contract --root . --execute --json`
verifies the declared bootstrap and Pages commands in a clean clone.

## Commands

```bash
bun run dev
bun run typecheck
bun test
bun run build
```

## Data Model

The app normalizes imported HTML, Markdown, and plain text through the existing
HTML extraction boundary and stores the extracted documents in IndexedDB
database `document-search`, object store `documents`. Export/import uses
`CorpusSnapshot` JSON with `schemaVersion: 1`.

The five demo documents are seeded only on a browser profile's first demo
initialization, and only when the local corpus starts empty. A separate IndexedDB
initialization marker means clearing the corpus or importing an empty snapshot
stays empty across reloads. Existing browser data is never overwritten by demo
initialization.

Search is request-scoped: the stored corpus is transformed into an in-memory
`text-index-wasm` search request for each query. Paragraph chunking is used so
results map back to extracted document paragraphs. `nlp-stack` remains
authoritative for retrieval and ranking semantics.

## Local filesystem corpus mode

For document folders too large for the browser demo, a local companion CLI keeps
a managed corpus directory on disk. It runs under Bun only and is never part of
the browser/Vite bundle; the IndexedDB browser mode is unchanged.

```bash
bun run corpus ingest --corpus ./my-corpus [--imported-at <iso>] ~/Documents/notes
bun run corpus sources --corpus ./my-corpus
bun run corpus rebuild-index --corpus ./my-corpus
bun run corpus search --corpus ./my-corpus [--top-k 10] [--mode hybrid|lexical|semantic] "query"
```

Every command prints JSON to stdout. `ingest` scans the folder recursively
(regular files only; symlinks are not followed) and reports how many path
aliases were added, updated, unchanged, removed, and unsupported.

The corpus directory holds:

- `payloads/<sha256[0..2]>/<sha256>`: the raw bytes of every scanned file,
  stored once per SHA-256 even when several paths hold identical bytes.
  Unsupported files are kept too, so later parser adapters can extract them from
  the corpus alone.
- `corpus.sqlite`: one source record per file path (its `file://` URI, payload
  hash, parser id and document id), the scanned roots that contain each path,
  and the extracted document records. It has no full-text tables. When
  overlapping roots were scanned, `sources` reports the most specific (longest)
  root and the path below it.
- `index/`: derived search-index state written by `rebuild-index`. It can be
  deleted at any time and rebuilt from the corpus records.

Supported files (HTML, Markdown, plain text) go through the same import and
extraction functions as browser uploads, so both modes produce the same
`ExtractedDocument` records and the same corpus-core export. A document's id is
derived only from its source URI, so each path keeps its own document and a
re-scan is deterministic: unchanged files keep their records and original import
time, changed bytes keep the document id, and deleted files lose their alias.
Re-scanning one root never removes files of another root that still exist, and
a file found through another, overlapping root counts as unchanged. A deleted
file is removed by re-scanning any root that contained it. Files no parser
adapter supports, such as PDF, are recorded as `unsupported` without a document;
PDF extraction is not implemented yet.

Search refuses to run while the index is missing or stale (after an ingest that
changed the corpus) and asks for `rebuild-index`. It then runs the same
request-scoped `nlp-stack` search as the browser, so ranking and filtering stay
in `nlp-stack`.

### Web captures

Web pages enter the filesystem corpus only through an explicit capture; search,
ingest and the browser app never fetch anything.

```bash
bun run corpus capture --corpus ./my-corpus [--url-list urls.txt] [<url> ...]
bun run corpus captures --corpus ./my-corpus
bun run corpus capture-payload --corpus ./my-corpus --out page.html <capture-id>
```

`capture` fetches each http(s) URL once with `GET` (one URL per line in
`--url-list`; blank and `#` lines are ignored), follows up to 10 redirects and
records every hop. It exits 1 when any URL failed; the other captures are kept.
For each capture the corpus stores:

- `warc/<capture-id>.warc`: a WARC 1.1 file with a `warcinfo` record (capture
  producer and version) and a `request`/`response` pair per redirect hop. The
  response body is kept exactly as received (`Accept-Encoding: identity` is
  requested; a server-applied content coding is kept, not decoded). Digests are
  `sha256:<hex>`. A final payload an earlier capture already archived is written
  as a `revisit` record (identical-payload-digest profile) without the bytes.
- the final payload under `payloads/`, once per SHA-256 like scanned files, so a
  capture can be inspected from its exact stored bytes after the live page
  changed (`capture-payload`).
- a capture record: requested and final URL, retrieval time, redirect chain,
  status, response headers, media type and charset, payload hash and length,
  WARC location/hash, producer/version and extraction status.

Every capture is its own record, and successful (2xx) HTML, Markdown and
plain-text responses become their own searchable document (source URI = final
URL, import time = retrieval time), even when another capture or URL returned
identical bytes; recapturing a URL keeps the earlier capture. Other responses are
captured without a document. In the corpus-core export a capture is a `url`
Source (requested URL; final URL, retrieval time, redirect chain, HTTP status and
capture producer in its metadata) with an Asset holding the exact payload hash,
`Content-Type` and WARC record; the extracted text is a separate
`extracted_text` Representation whose provenance names the asset and extractor.
A successful capture says nothing about a source's reliability or authority.

## Heading-path export contract

Paragraph heading paths are dense arrays of **actual heading text**, from outermost active
ancestor to innermost heading. An HTML heading's numeric level controls when existing
headings are replaced, but skipped levels do not add placeholders:

- `<h2>A</h2><p>x</p>` gives `["A"]` for the heading and paragraph.
- `<h1>T</h1><h3>B</h3><p>y</p>` gives `["T", "B"]` for the paragraph.
- A following `<h2>C</h2>` replaces `B`, yielding `["T", "C"]`.

The same representation is emitted as `SourceLocatorV1.headingPath` in the
`source_span_interchange` v1 JSON export, and as a JSON-encoded string array in
corpus-core segment `metadata.heading_path` in the `moenarch_corpus_core_batch` v1
JSONL export. Neither includes `null`, sparse holes, or empty strings for skipped
levels. Heading text and ancestor ordering are preserved, and source/segment ID
derivation remains unchanged. A source-span revision may change when its structural
heading metadata changes.

This rule applies during extraction to newly imported documents. Documents already
stored with legacy sparse heading paths need re-extraction from their original HTML;
exports do not silently rewrite their stored provenance.

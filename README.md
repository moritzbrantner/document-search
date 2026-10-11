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

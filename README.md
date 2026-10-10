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
repository and run `bun install`.

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

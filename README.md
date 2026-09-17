# Document Search

Local-first document search app built with Bun, Vite, React, TypeScript,
IndexedDB, and the text WASM packages from the sibling `nlp-stack` source
checkout. Development does not wait for npm publication.

The GitHub Pages build is a usable browser demo. A fresh browser corpus starts
with five deterministic demo documents, and users can add their own HTML,
Markdown, or plain-text files. Uploaded files are parsed in the browser, stored
in IndexedDB, and included in subsequent searches without sending the corpus to
a hosted search service.

## Setup

Check out `nlp-stack` beside this repository at the exact revision recorded in
`.nlp-stack-rev`, then build and install the source dependencies:

```bash
git clone https://github.com/moritzbrantner/nlp-stack.git ../nlp-stack
git -C ../nlp-stack checkout "$(cat .nlp-stack-rev)"
./scripts/setup-source-deps
```

The setup script refuses a moving or mismatched `nlp-stack` checkout before it
builds `text-core-wasm`, builds `text-index-wasm`, and runs `bun install`.

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

# Document Search

Local-first HTML document search app built with Bun, Vite, React, TypeScript,
IndexedDB, and the text WASM packages from the sibling `nlp-stack` source
checkout. Development does not wait for npm publication.

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

The app stores extracted HTML documents in IndexedDB database
`document-search`, object store `documents`. Export/import uses
`CorpusSnapshot` JSON with `schemaVersion: 1`.

Search is request-scoped: the stored corpus is transformed into an in-memory
`text-index-wasm` search request for each query. Paragraph chunking is used so
results map back to extracted HTML paragraphs.

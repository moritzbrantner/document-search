# Document Search

Local-first HTML document search app built with Bun, Vite, React, TypeScript,
IndexedDB, and the local Rust/WASM text packages from `../rust-packages`.

## Setup

Build the local WASM packages first:

```bash
bun run --cwd ../rust-packages/packages/text-core-wasm build
bun run --cwd ../rust-packages/packages/text-index-wasm build
```

Install dependencies:

```bash
bun install
```

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

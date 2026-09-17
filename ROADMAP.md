# Document Search Roadmap

Document Search should stay local-first and keep retrieval semantics in `nlp-stack` rather than growing a second search engine in the React application.

## Demo and ingestion

1. [x] **Publish a searchable GitHub Pages demo.** Seed a fresh browser with five deterministic documents so search is immediately useful without setup.
2. [x] **Upload browser-readable documents.** Accept HTML, Markdown, and plain text, normalize them through the existing extraction boundary, persist them in IndexedDB, and include them in search without a server-side corpus.
3. [ ] **Add richer document formats deliberately.** Add PDF and office-document extraction behind explicit parser adapters, preferably off the main thread, with size limits and regression fixtures before enabling them in the public demo.
4. [ ] **Make ingestion observability explicit.** Surface parse duration, extracted paragraph counts, rejected files, and index synchronization state without moving ranking policy into the application.

## Search quality

1. [x] **Make exact-phrase constraints authoritative in `text-index`.** Parse quoted phrases in Document Search, pass them through as `requiredPhrases`, and remove bounded app-side candidate widening/filtering.
2. [x] **Add typo-tolerant / fuzzy lexical retrieval.** Use bounded deterministic fuzzy expansion from the `nlp-stack` `index.search` package surface, expose it through WASM, and keep the Document Search control explicit. The initial slice is lexical-only and reports the correction used for each result.
3. [ ] **Add field and metadata filters.** Support narrowing by document/title, source URI, import time, and selected document IDs through the existing `IndexFilter` boundary; compose filters with phrase constraints and retrieval mode.
4. [ ] **Add a small query language.** Build on the structured query contract for field qualifiers and boolean/exclusion operators while keeping quoted phrases backward-compatible. Parsing belongs at the product boundary; ranking/filter semantics belong in `nlp-stack`.
5. [ ] **Make repeated searches incremental.** Stop rebuilding the complete transient index for every query. Keep a worker-owned in-memory index synchronized with IndexedDB corpus mutations, with deterministic rebuild as the recovery path.
6. [ ] **Expose ranking and match diagnostics.** Surface lexical/semantic score breakdowns, exact/fuzzy matches, and useful highlighting without turning diagnostics into a second ranking policy.

## Acceptance principles

- Local-first and no-network search remains the default.
- `nlp-stack` owns retrieval, ranking, filtering, and fuzzy-match semantics.
- Document Search owns corpus interaction, query parsing, controls, and result presentation.
- Search behavior must be deterministic for the same corpus, query, and options.
- New search modes need focused regression coverage before they become defaults.

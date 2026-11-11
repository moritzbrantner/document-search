# Document Search Roadmap

Document Search should stay local-first and keep retrieval semantics in `nlp-stack` rather than growing a second search engine in the React application.

## Demo and ingestion

1. [x] **Publish a searchable GitHub Pages demo.** Seed a fresh browser with five deterministic documents so search is immediately useful without setup.
2. [x] **Upload browser-readable documents.** Accept HTML, Markdown, and plain text, normalize them through the existing extraction boundary, persist them in IndexedDB, and include them in search without a server-side corpus.
3. [ ] **Add richer document formats deliberately.** Add PDF and office-document extraction behind explicit parser adapters, preferably off the main thread, with size limits and regression fixtures before enabling them in the public demo.
4. [x] **Add a local filesystem corpus mode for large folders.** A Bun CLI (`bun run corpus`) ingests nested folders deterministically into a managed corpus directory: content-addressed SHA-256 payloads, SQLite source/path aliases and document records, and a rebuildable derived index. It reuses the browser import, extraction, search and corpus-core export functions, and leaves ranking in `nlp-stack`. Parser adapters are the seam for richer formats; embedded PDF text with page provenance is supported in filesystem mode (#22), while OCR, office formats and browser PDF uploads remain open (item 3).
5. [x] **Capture web pages reproducibly.** An explicit `bun run corpus capture` stores each requested URL as a WARC 1.1 file (request/response per redirect hop) plus its exact payload, records retrieval provenance, and exports captures as corpus-core Source/Asset records with extracted text as a derived Representation. Ordinary search stays network-free.
6. [ ] **Make ingestion observability explicit.** Surface parse duration, extracted paragraph counts, rejected files, and index synchronization state without moving ranking policy into the application.

## Corpus interoperability

1. [x] **Expose stable source and span records for downstream consumers.** Export deterministic document identity plus text spans with source revision, locator, language, metadata, verbatim text, and a content hash.
2. [ ] **Preserve parser provenance.** A downstream philosophical statement must be traceable back through the exported span to the exact imported document and parser/extraction revision that produced it.
3. [ ] **Add a deterministic batch/export boundary.** Prefer a versioned JSON/JSONL-style contract that can be consumed by tools such as `philosophy-extractor` without coupling them to IndexedDB or the React application.
4. [ ] **Keep philosophical interpretation downstream.** `document-search` may expose source material and search results, but philosophical relevance, claim extraction, argument roles, and worldview semantics belong in `philosophy-extractor` and `worldview-lab`.
5. [ ] **Keep local-first behavior authoritative.** Exporting to a downstream processor must remain explicit; ordinary document search must not silently upload a local corpus to a hosted model service.

## Search quality

1. [x] **Make exact-phrase constraints authoritative in `text-index`.** Parse quoted phrases in Document Search, pass them through as `requiredPhrases`, and remove bounded app-side candidate widening/filtering.
2. [x] **Add typo-tolerant / fuzzy lexical retrieval.** Use bounded deterministic fuzzy expansion from the `nlp-stack` `index.search` package surface, expose it through WASM, and keep the Document Search control explicit. The initial slice is lexical-only and reports the correction used for each result.
3. [x] **Add field and metadata filters.** Resolve title, source URI, import-date, and explicit document scope against the browser-owned corpus, then pass the resulting document IDs through `IndexFilter` so filtering happens before ranking rather than after results return.
4. [ ] **Add a small query language.** Build on the structured query contract for field qualifiers and boolean/exclusion operators while keeping quoted phrases backward-compatible. Parsing belongs at the product boundary; ranking/filter semantics belong in `nlp-stack`.
5. [ ] **Make repeated searches incremental.** Stop rebuilding the complete transient index for every query. Keep a worker-owned in-memory index synchronized with IndexedDB corpus mutations, with deterministic rebuild as the recovery path.
6. [ ] **Expose ranking and match diagnostics.** Surface lexical/semantic score breakdowns, exact/fuzzy matches, and useful highlighting without turning diagnostics into a second ranking policy.

## Acceptance principles

- Local-first and no-network search remains the default.
- `nlp-stack` owns retrieval, ranking, filtering, and fuzzy-match semantics.
- Document Search owns corpus interaction, query parsing, controls, result presentation, and source-span export.
- Search behavior must be deterministic for the same corpus, query, and options.
- New search modes need focused regression coverage before they become defaults.
- Downstream philosophical processing must not become a hidden search-ranking dependency.

# Document Search Roadmap

Document Search should stay local-first and keep retrieval semantics in `nlp-stack` rather than growing a second search engine in the React application.

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
- Document Search owns corpus interaction, query parsing, controls, and result presentation.
- Search behavior must be deterministic for the same corpus, query, and options.
- New search modes need focused regression coverage before they become defaults.

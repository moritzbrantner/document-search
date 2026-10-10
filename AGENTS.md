# Agent guidance

## Repository boundaries

- Read `CONTEXT.md` for domain vocabulary and `README.md` / `ROADMAP.md` for implemented versus planned capabilities.
- Document Search owns corpus ingestion and storage, query parsing, search controls, result presentation, source-span export and the user-facing inspection workflow. `nlp-stack` owns retrieval, ranking, filtering and fuzzy-match semantics (see `ROADMAP.md` acceptance principles); call its extraction/index packages through their existing boundary and do not add a local ranking or filtering policy.
- Preserve source-document provenance and deterministic duplicate detection. Do not describe deferred PDF functionality as implemented.

## Authority boundaries

Machine-readable in `.repository.toml` (`[architecture]`); keep both lists identical.

- Owns: `document-search/corpus-ingestion`, `document-search/corpus-persistence`, `document-search/query-parsing`, `document-search/search-ui`, `document-search/source-span-export`
- Adapts: `nlp-stack/text-core`, `nlp-stack/text-index`, `nlp-stack/retrieval-semantics`
- Non-authoritative: `nlp-stack/text-core`, `nlp-stack/text-index`, `nlp-stack/retrieval-semantics`

## Conventions and task context

- Repository-local instructions override shared conventions. When a managed `conventions.json` installation exists, consume its selected modules and `.conventions/index.md`. Until then resolve the current shared convention source through `coding-tooling`; do not guess rules after resolution failures.
- Prefer `coding-tooling inspect --target <existing-path> --json` for focused context. Retain root/ancestor instructions and conservative fallback for partial results.

## Validation

- Use the semantic tiers in `.coding-tooling.json`: `coding-tooling plan --tier fast --json`, then `coding-tooling run --tier fast --strict --json` for relevant work; the full tier additionally builds.
- Repository-owned scripts remain the authority (`bun run format:check`, `bun run lint`, `bun run typecheck`, `bun run test`, `bun run build`).
- The text WASM packages come from the commit-pinned git dependency `@moritzbrantner/nlp-stack-wasm` (subpaths `/text-core-wasm` and `/text-index-wasm`, listed in `trustedDependencies`); a clean clone runs with `bun install` then `bun dev`. Its `prepare` build needs git, rustup and wasm-pack; a missing toolchain is an environment gap, not successful validation. Change retrieval semantics in `nlp-stack`, ship them through `nlp-stack-wasm`, then move the pin here. Preserve `bun.lock`.
- `.repository.toml` declares purpose, ownership, bootstrap and Pages commands. `coding-tooling repository contract --root . --json` checks the declarations; add `--execute` to run bootstrap and Pages acceptance in a disposable clean clone of the committed revision.
- There is no local nlp-stack source mode yet: the standard `coding-tooling source-deps` JavaScript mode cannot build `@moritzbrantner/nlp-stack-wasm` from a local `nlp-stack` checkout. Do not reintroduce a revision file, sibling `file:` dependencies or a bespoke setup script; land upstream changes in `nlp-stack`, then in `nlp-stack-wasm`, then move the pin here.
- Retain the hosted Validate/Pages checks; do not weaken actual integration or browser acceptance requirements.

# Agent guidance

## Repository boundaries
- Read `CONTEXT.md` for domain vocabulary and `README.md` / `ROADMAP.md` for implemented versus planned capabilities.
- Document Search owns corpus ingestion, indexing, search, and the user-facing inspection workflow. Reuse the sibling `nlp-stack` extraction/index packages through their existing boundary; do not duplicate NLP authority locally.
- Preserve source-document provenance and deterministic duplicate detection. Do not describe deferred PDF functionality as implemented.

## Conventions and task context
- Repository-local instructions override shared conventions. When a managed `conventions.json` installation exists, consume its selected modules and `.conventions/index.md`. Until then resolve the current shared convention source through `coding-tooling`; do not guess rules after resolution failures.
- Prefer `coding-tooling inspect --target <existing-path> --json` for focused context. Retain root/ancestor instructions and conservative fallback for partial results.

## Validation
- Use the semantic tiers in `.coding-tooling.json`: `coding-tooling plan --tier fast --json`, then `coding-tooling run --tier fast --strict --json` for relevant work; the full tier additionally builds.
- Repository-owned scripts remain the authority (`bun run format:check`, `bun run lint`, `bun run typecheck`, `bun run test`, `bun run build`).
- This app has sibling `nlp-stack` file dependencies and the pinned revision in `.nlp-stack-rev`. An unavailable sibling checkout is an environment/setup gap, not successful validation. Preserve `bun.lock`.
- Retain the hosted Validate/Pages checks; do not weaken actual integration or browser acceptance requirements.

# Text WASM Consumer Readiness

Issue [#127](https://github.com/moritzbrantner/rust-packages/issues/127)
tracks the replacement of Document Search's sibling `file:` dependencies for
the text WASM packages. This document records the consumer-side audit performed
on 2026-08-21 and the exact condition required before that manifest migration
can be made safely.

## Current state

Document Search intentionally retains its existing `file:` dependencies in
`package.json` and `bun.lock`. Replacing them now would make a clean checkout
uninstallable: no installable artifact exists for either canonical package.

| Package | Intended source owner | Availability finding | Consumer action |
| --- | --- | --- | --- |
| `@moritzbrantner/text-core-wasm` | `moritzbrantner/nlp-stack` | Version `0.1.0` is package source only; it is absent from both npmjs and GitHub Packages. | Keep the existing dependency until an exact released artifact exists. |
| `@moritzbrantner/text-index-wasm` | `moritzbrantner/nlp-stack` | Version `0.1.0` is package source only, is marked `private: true`, and is absent from both registries. | Keep the existing dependency until it is made installable under an approved release plan. |

The Rust workspace ownership record classifies both wrappers as requiring a
separate npm/WASM release decision; it does not authorize npm publication. No
package is published or copied by this migration slice.

## Ownership audit

`platform-packages` does not provide either canonical package. Its adjacent
`@moritzbrantner/linguistics-core` package still points at the historical
`@mb-rust/text-core-wasm` sibling path, and no corresponding text-index package
was found. That historical alias is also unavailable from npmjs and GitHub
Packages. It must not become a second publication path for Document Search.

The next release decision must therefore name one publication owner and one
registry for both canonical `@moritzbrantner/*-wasm` packages. The owner must
coordinate the TypeScript/browser contract boundary with
[#132](https://github.com/moritzbrantner/rust-packages/issues/132); Document
Search remains the owner of its product behavior, corpus, and UI integration.

## Required contract compatibility

Before this consumer switches to an installable dependency, the released
artifacts must contain the generated WASM output and preserve these public
contracts:

- `@moritzbrantner/text-core-wasm` exports `analyzeTextDocument` and
  `segmentTextDocument`, plus the `TextDocumentAnalysis` and
  `SegmentedTextDocument` TypeScript declarations used by the browser intake
  and inspector flows.
- `@moritzbrantner/text-index-wasm` exports `init` and `runOperation`, plus
  `SurfaceResponse`. The public entry point must initialize the generated
  module without requiring consumers to import a generated `pkg/` file
  directly.
- The emitted response values remain JSON-like after conversion of WASM
  `Map` values, preserving the `SurfaceResponse` operation, value,
  diagnostics, and artifacts fields used by the browser search flow.

## Exact unblock condition

This issue can update `package.json`, refresh `bun.lock`, and remove the
sibling-path setup instructions only after all of the following are true:

1. An exact npm/WASM release issue and checked-in release manifest designate
   the owner, registry, immutable version, and package names for both wrappers.
2. The designated owner has produced installable artifacts containing the
   generated WASM files and declarations above; `text-index-wasm` is no longer
   private for that authorized distribution.
3. The owner has recorded a passing pack dry-run and isolated install smoke
   against those exact artifacts, and the contract/ownership decision with
   `platform-packages` is recorded.
4. Document Search can pin those exact versions and verify its own install,
   typecheck, build, and tests in a clean checkout.

Until then, a guessed registry version, Git default-branch dependency, copied
generated `pkg/` tree, or duplicate platform package would violate the
migration boundary rather than solve the clean-checkout requirement.

## Verification status

Per the migration request, this documentation-only slice did not run package
installation, pack, build, typecheck, lint, or test commands. The registry and
ownership observations above are read-only metadata and manifest inspections,
not proof that the unavailable packages install.

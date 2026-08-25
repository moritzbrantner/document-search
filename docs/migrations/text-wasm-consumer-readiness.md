# Text WASM Source Consumer Migration

Issue [#127](https://github.com/moritzbrantner/rust-packages/issues/127)
tracked removal of Document Search's dependency on the old `rust-packages`
checkout.

## Decision

Ordinary development now consumes both canonical WASM wrappers directly from
their owner, [`moritzbrantner/nlp-stack`](https://github.com/moritzbrantner/nlp-stack):

| Package | Source path |
| --- | --- |
| `@moritzbrantner/text-core-wasm` | `../nlp-stack/packages/text-core-wasm` |
| `@moritzbrantner/text-index-wasm` | `../nlp-stack/packages/text-index-wasm` |

The exact source revision is recorded in `.nlp-stack-rev`. The setup script
verifies the sibling checkout before building either wrapper, so normal product
work is reproducible without requiring npm publication.

## Preserved contract

- `@moritzbrantner/text-core-wasm` exports `analyzeTextDocument` and
  `segmentTextDocument`, plus the declarations used by browser intake and
  inspector flows.
- `@moritzbrantner/text-index-wasm` exports `init` and `runOperation`,
  plus `SurfaceResponse`.
- WASM response values remain JSON-like after conversion of `Map` values.

Publication remains a separate distribution concern. A future npm release may
replace the sibling paths after an isolated pack/install smoke, but it is no
longer a prerequisite for source development.

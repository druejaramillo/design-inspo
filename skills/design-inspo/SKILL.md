---
name: design-inspo
description: The design-inspo skill searches the local Field Notes catalog for tag-based inspiration when the user requests it or a design task needs visual direction.
---

# Design Inspiration

Use the local `inspo` CLI to turn saved Field Notes references into grounded art direction.

## Workflow

1. Select tags from the user's stated or inferred visual direction. When that direction is unclear, run `inspo overview` first to discover the available tag terms; ask only if the overview does not resolve it.
2. Query the catalog with `inspo context --tags "tag-one,tag-two"`. If `inspo` is not on `PATH`, run `npm run inspo -- context --tags "tag-one,tag-two"` from the design-inspo repository root.
3. Tag matching is AND by default. Use `--mode or` only when intentionally broadening exploration.
4. `overview` returns only tags with at least one matching item, grouped by taxonomy. Treat `count` as the total number of matches and `references` as an at-most-six-item sample. `imagePath` and `sourceUrl` can be `null`. If `count` is zero, say that the catalog has no match; do not treat the generic prompt as reference evidence.
5. When individual references or a broader item list would help, run `inspo search --tags "tag-one,tag-two"` with the same match mode. Inspect only non-null `imagePath` values, resolved against the design-inspo repository root or `INSPO_ROOT` when it is set.
6. Use the returned prompt and references as art direction for hierarchy, texture, rhythm, and visual language. Do not copy brands, logos, or exact layouts.
7. State which tag direction informed the work. Report no-match results honestly and suggest a neighboring direction when useful.

## Read-Only Boundary

Do not run or recommend `inspo import`, `inspo analyze`, or `inspo validate`. This skill does not edit catalog entries or analyses.

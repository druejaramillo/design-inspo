# Field Notes

A local-first, Git-native design inspiration catalog. Save screenshots or public links, curate them with tags, analyze their visual language, and turn a slice of the collection into useful art direction for OpenCode.

## Run locally

Requirements: Node.js 22+ and npm.

```sh
npm install
npm run dev
```

Open `http://localhost:5173`. The local catalog service runs on port `8787`; Vite proxies browser API requests to it.

For a production-like local server:

```sh
npm run build
npm run serve
```

Then open `http://localhost:8787`.

## Everyday workflow

1. Drag a screenshot/image into the page, or paste a public source URL.
2. The app stores one JSON record in `catalog/items/` and a normalized WebP in `catalog/media/`.
3. Add a few deliberate tags and private notes in the item panel.
4. Run visual analysis with OpenCode. It gives the reference a concise descriptive title and generates palette, visual-reading, and hero-image recreation guidance.
5. Filter the shelf and copy its direction into an AI coding task, or ask OpenCode to use a tag combination.

The importer reads ordinary public page metadata (`og:image`, `og:title`, and similar). It does not bypass source-site restrictions. If a source does not permit a preview image fetch, the source link is saved and the UI asks for a screenshot.

## AI analysis

`Analyze with OpenCode` attaches the saved image to the project-local `catalog-vision` OpenCode agent, which has no repository or shell tool permissions. It runs `openai/gpt-5.6-luna --variant minimal` and requests a schema-validated analysis. Authenticate OpenCode's OpenAI provider before using it. Each run times out after four minutes and can be canceled from the item panel. Failed or canceled runs preserve any prior valid analysis and show a retryable diagnostic in that panel.

The optional `Use OpenAI` button uses a server-side environment variable:

```sh
OPENAI_API_KEY=... npm run dev:server
```

You can also put `OPENAI_API_KEY` and an optional `OPENAI_VISION_MODEL` in an uncommitted `.env` file. Browser code never receives this key.

## CLI

Install the `inspo` command on your PATH (from this repo, after `npm install`):

```sh
npm link
# remove later: npm unlink -g design-inspiration
```

Useful commands (work from any directory; catalog stays in this repo):

```sh
inspo search --tags "editorial,warm"
inspo context --tags "editorial,warm,serif"
inspo context --tags "playful,primary-pop" --mode or
inspo import /path/to/screenshot.png --title "Idea for the archive"
inspo import https://example.com/reference
inspo analyze item-id --provider opencode
inspo validate
```

Override the catalog root with `INSPO_ROOT` if needed. In-repo `npm run inspo -- …` still works.

`inspo analyze` reports the provider/model, final status, and generated title. OpenCode runs always use `openai/gpt-5.6-luna`; pass `--provider openai` to use the direct API adapter instead.

## Use from OpenCode

The project skill at `.opencode/skills/inspiration-catalog/SKILL.md` tells OpenCode how to draw from the catalog. Restart OpenCode after pulling this project/configuration change so it discovers the new skill.

`context` returns a compact prompt fragment plus bounded reference paths and source URLs. An agent can inspect those local files when the task needs more than the summary.

## Storage and publishing

The repository is the source of truth. Commit `catalog/items/`, `catalog/media/`, `catalog/taxonomy.json`, and `catalog/index.json` together. Plain Git is practical for a modest personal collection; migrate media to R2 or Git LFS once clone size becomes inconvenient.

`npm run build` copies the catalog into the static output. Deploy `dist/` to Cloudflare Pages for read-only remote browsing. The static UI automatically falls back to that published catalog when its local API is unavailable. Keep imports and AI enrichment local until there is a real need for authenticated hosted editing; then move media to R2 and add Worker/D1 endpoints without changing item IDs or the CLI contract.

## Verification

```sh
npm test
npm run validate
npm run build
```

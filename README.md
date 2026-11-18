# Field Notes

A local-first, Git-native design inspiration catalog. Save screenshots or public links, curate them with tags, analyze their visual language, and turn a slice of the collection into useful art direction for Pi.

## Run locally

Requirements: Node.js 22.19+, npm, Pi 1.5.2+ on `PATH`, and `pi-better-openai` for image analysis.

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
4. Run visual analysis with Pi. It gives the reference a concise descriptive title and generates palette, visual-reading, and hero-image recreation guidance.
5. Filter the shelf and copy its direction into an AI coding task, or ask Pi to use a tag combination.

The importer reads ordinary public page metadata (`og:image`, `og:title`, and similar). It does not bypass source-site restrictions. If a source does not permit a preview image fetch, the source link is saved and the UI asks for a screenshot.

## AI analysis

`Analyze with Pi` uses `openai-codex/gpt-6-luna` with **Fast mode** and **high thinking**. It attaches the saved image to a one-shot `pi --print --mode json` process. The process disables tools, MCP, skills, prompt templates, themes, context files, and project-local configuration. Only `pi-better-openai` is loaded explicitly. The server validates the final assistant JSON against the catalog schema and retries incomplete output once.

Install the extension if needed:

```sh
pi install npm:@monotykamary/pi-better-openai
```

Start `pi` and sign in with `/login openai-codex`. Field Notes uses those Pi credentials without changing your global model or thinking settings.

Each analysis gets a temporary working directory with its own Better OpenAI config. The config requests `serviceTier: "fast"`, which injects `service_tier: "priority"`. It disables usage polling, reset redemption, image generation, web search, decisions, live voice, and pets. The temporary directory is removed after success, failure, or cancellation. No Pi session is saved. Fast mode requests priority processing; the provider decides whether to honor it.

Field Notes loads the installed extension from `$PI_CODING_AGENT_DIR/npm/node_modules/@monotykamary/pi-better-openai/index.ts`, with `~/.pi/agent` as the default agent directory. For a Git install or another location, set `PI_VISION_EXTENSION` to its local `index.ts` path. A missing extension stops analysis instead of silently running without Fast mode.

To override the model, set `PI_VISION_MODEL` to an image-capable `openai-codex/model` or `openai/model` ID that supports Fast mode. You can use an uncommitted `.env` file or the server environment. High thinking and Fast mode remain enabled. The default is `openai-codex/gpt-6-luna`; the `openai/gpt-6-luna` Decisions classifier is not a chat-model substitute.

Each run times out after four minutes and can be canceled from the item panel. Failed or canceled runs preserve any prior valid analysis and show a retryable diagnostic. Existing OpenCode analyses remain readable and keep their original provider metadata. New analysis requests use `pi` by default.

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

Start the catalog from any directory:

```sh
inspo gui
```

This runs the repository's development server from the project root. Open `http://localhost:5173` in your browser.

Useful commands (work from any directory; catalog stays in this repo):

```sh
inspo overview
inspo search --tags "editorial,warm"
inspo context --tags "editorial,warm,serif"
inspo context --tags "playful,primary-pop" --mode or
inspo import /path/to/screenshot.png --title "Idea for the archive"
inspo import https://example.com/reference
inspo analyze item-id --provider pi
inspo validate
```

Override the catalog root with `INSPO_ROOT` if needed. In-repo `npm run inspo -- …` still works.

`inspo analyze` defaults to Pi and reports the selected model, Fast mode, high thinking, final status, and generated title. Pass `--provider openai` to use the direct API adapter instead. The retired `--provider opencode` is no longer accepted.

## Use from Pi

The skill at `skills/design-inspo/SKILL.md` tells Pi how to draw from the catalog. Load it from the repository root:

```sh
pi --skill ./skills/design-inspo
```

Use `/skill:design-inspo` in that Pi session, or ask Pi for a tag-based direction. The skill only reads the catalog. It does not import or analyze references.

`overview` lists the taxonomy tags currently represented in the catalog, their item counts, and a compact recent-reference sample. Use it to choose terms for `search` or `context`.

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

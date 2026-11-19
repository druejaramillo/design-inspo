# Field Notes

A local-first, Git-native design inspiration catalog. Save screenshots or public links, curate them with tags, analyze their visual language, and turn a slice of the collection into useful art direction for Pi.

## Run locally

Requirements: Node.js 22.19+, npm, Pi 1.5.2+ on `PATH`, and `pi-better-openai` for image analysis.

```sh
npm install
npm run dev
```

Open `http://localhost:5173`. The local catalog service runs on port `8787`; Vite proxies browser API requests to it.

To preview the published, read-only site in a local Worker:

```sh
npm run dev:published
```

Open `http://127.0.0.1:8788`. This preview does not enable catalog management or deploy to Cloudflare.

## Everyday workflow

1. Drag a screenshot/image into the page, or paste a public source URL.
2. The app stores one JSON record in `catalog/items/` and a normalized WebP in `catalog/media/`.
3. Add deliberate tags and local notes in the item panel. Notes stay out of published assets, but remain in Git if you commit them.
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

## Connect an agent

After deployment, add `https://design.druejaramillo.com/mcp` as a Streamable HTTP MCP server in your agent app. No repository checkout, local server process, API key, or CLI is required.

The server exposes four read-only tools:

- `inspo_overview` discovers represented taxonomy tags and counts.
- `inspo_search` finds references by tags, with AND or OR matching and pagination.
- `inspo_context` returns compact art direction and at most six references.
- `inspo_get_reference` returns public details and can include a saved image up to 2 MiB.

The JSON API supports the same reads for agents without MCP. See the [API reference](docs/catalog-api.md) for parameters and the [publishing guide](docs/publishing.md) for Cloudflare setup.

The optional skill at `skills/design-inspo/SKILL.md` describes the remote workflow and HTTP fallback. Install or load that skill in your agent app. It does not depend on local catalog files. The former `inspo` CLI has been removed. If you previously installed it with `npm link`, remove that old link with `npm unlink -g design-inspiration`.

## Storage and publication

The repository remains the source of truth. Commit `catalog/items/`, `catalog/media/`, `catalog/taxonomy.json`, and `catalog/index.json` together. Set `INSPO_ROOT` only to use a different local catalog root.

`npm run build` creates `dist/catalog/catalog.json` from an allowlist of public fields and copies only referenced media. It does not publish raw item records, local notes, or analysis errors. Visual analysis descriptions and hero prompts are public. A public Git repository still exposes any notes committed to Git.

Production builds always use the read-only snapshot. Development mode always uses the local management API and does not silently fall back to an older export. Local edits reach the website and remote tools only after a new deployment.

Deploy the Worker and `dist/` together. Static-only hosting provides the browser but not MCP or the query API. No hosted editor, database, or AI credentials are required.

## Verification

```sh
npm test -- --maxWorkers=2 --no-file-parallelism
npm run validate
npm run check:worker
npm run verify:published
```

# Public catalog API

All routes read the deployed snapshot. They never edit the Git catalog or run AI analysis. JSON responses use `Cache-Control: no-store` and allow cross-origin reads. The catalog snapshot and images are static assets.

## MCP

The endpoint is `/mcp`. It supports current and legacy Streamable HTTP clients without storing sessions. Each client must configure the server before its agent can discover the tools. It does not support the retired HTTP-plus-SSE transport with separate `/sse` and message endpoints.

| Tool | Arguments | Result |
| --- | --- | --- |
| `inspo_overview` | None | Item and analysis counts, represented taxonomy tags with counts, recent references |
| `inspo_search` | `tags`, `mode`, `limit`, `offset` | Total count and a paginated reference list |
| `inspo_context` | `tags`, `mode` | Total count, art-direction prompt, at most six references |
| `inspo_get_reference` | `id`, optional `includeImage` | Public item details and an optional image |

`tags` is an array of taxonomy tag IDs with at most 24 values. `mode` is `and` by default or `or`. `limit` defaults to 20 and accepts integers from 1 to 100. `offset` defaults to 0 and accepts integers from 0 to 1000000. `includeImage` defaults to false. Inline images are limited to 2 MiB. A larger image remains accessible through its public URL.

Each tool has read-only and idempotent annotations. The server enforces this boundary by providing no mutation tools or local storage adapters. MCP uses POST for protocol messages even when the requested tool only reads.

Native clients without an Origin header can connect directly. Browser requests must use the site's own origin or an exact origin listed in `MCP_ALLOWED_ORIGINS`. Separate allowed origins with commas. Preflight responses allow the MCP protocol headers.

## JSON routes

The production origin is `https://design.druejaramillo.com` after deployment. For a local preview, use `http://127.0.0.1:8788`.

| Method and path | Result |
| --- | --- |
| `GET /api/health` | Snapshot availability, published mode, generation time |
| `GET /api/overview` | Same data as `inspo_overview` |
| `GET /api/search` | Same data as `inspo_search` |
| `GET /api/context` | Same data as `inspo_context` |
| `GET /api/items/ITEM_ID` | Same public details as `inspo_get_reference`, without inline image content |
| `GET /api/taxonomy` | Complete taxonomy |

The search and context routes accept comma-separated `tags` and `mode=and` or `mode=or`. Search also accepts `limit` and `offset` with the MCP bounds. An omitted or empty tag list matches the whole catalog. Unknown tags produce no matches under AND matching. OR matching can still match other requested tags.

Reference results contain `id`, `title`, combined manual and suggested `tags`, nullable `sourceUrl`, and nullable absolute `imageUrl`. Search returns the total match `count` independently of the returned page size. Context returns the total count independently of its six-reference sample. A zero count returns an explicit no-match prompt.

HEAD returns the same status and headers without a body. OPTIONS supports cross-origin GET requests. Invalid query arguments return 400. Missing routes and references return 404. Mutation methods return 405. A missing or invalid deployed snapshot returns 503. Errors are JSON rather than the site's HTML shell.

## Public files

`/catalog/catalog.json` contains version 1 of the published snapshot. Its items include IDs, titles, source URLs and domains, import times, media metadata, manual tags, saved analysis, and analysis status. Saved analysis includes descriptive notes and hero prompts. Local item notes, analysis errors, source-image URLs, capture metadata, and update timestamps are not published.

`/catalog/media/` contains only media referenced by the snapshot. Raw `/catalog/items/` records and the old `/catalog/index.json` are not exported.

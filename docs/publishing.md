# Publish Field Notes on Cloudflare

Publish the Worker and static assets together. Cloudflare Pages or another static-only host does not provide MCP or the JSON query API.

## Check the local build

1. Install the locked dependencies with Node.js 22.19 or later.

   ```sh
   npm ci
   ```

2. Run the tests and local Worker verification.

   ```sh
   npm test -- --maxWorkers=2 --no-file-parallelism
   npm run check:worker
   npm run verify:published
   ```

   `check:worker` builds and packages the Worker without deploying. `verify:published` builds the site, starts a disposable local Worker, connects an MCP client, checks the public API and assets, rejects write requests, and stops its own process. It does not require Cloudflare authentication.

3. Check local catalog data before publication.

   ```sh
   npm run validate
   ```

   Correct any missing media or unknown tag IDs in the local catalog. The validator does not change records or rebuild the index.

4. To inspect the public site yourself, start its local preview.

   ```sh
   npm run dev:published
   ```

   Open `http://127.0.0.1:8788`. The MCP endpoint is `http://127.0.0.1:8788/mcp`. This is a read-only preview. Use `npm run dev` for catalog management.

## Connect the Git repository

1. In Cloudflare Workers, connect the repository containing this project.
2. Name the Worker `design-inspo` to match `wrangler.jsonc`.
3. Select the production branch. This repository uses `master`.
4. Set the build command to `npm run build`.
5. Set the deploy command to `npx wrangler deploy`.
6. Keep the project root as the root directory.
7. Configure Node.js 22.19 or later for the build environment.

The build uses only the Git catalog. Do not add Pi credentials, `OPENAI_API_KEY`, or other analysis secrets to Cloudflare. Leave `INSPO_ROOT` unset in Cloudflare so the build reads this checkout.

The Worker configuration is `wrangler.jsonc`. The `ASSETS` binding serves `dist/`. API and MCP requests run through the Worker before asset routing. There are no D1, KV, R2, or Durable Object bindings.

## Configure the domain

`wrangler.jsonc` declares `design.druejaramillo.com` as a custom domain. Activate the `druejaramillo.com` Cloudflare zone in the account where you deploy. Check for an existing DNS record that conflicts with the custom domain before deployment.

To test under `workers.dev` before attaching the domain, remove the custom-domain `routes` entry in your own deployment configuration.

For a manual deployment after Cloudflare authentication, use:

```sh
npm run deploy
```

This command rebuilds the public snapshot before deploying. The development and verification commands do not deploy.

## Connect agents

After deployment, add `https://design.druejaramillo.com/mcp` as a Streamable HTTP server in each MCP-capable client. No login or API key is required. Discover the four `inspo_` tools, then call `inspo_overview` before choosing tags.

For a browser-based MCP client that sends an Origin header, add its exact origin to the optional Worker variable `MCP_ALLOWED_ORIGINS`. For example, a comma-separated value can allow two specific web apps. Native clients that omit Origin do not need this setting. This variable is not an authentication control. The catalog remains public.

Agents without MCP can use the [JSON API](catalog-api.md). The optional repository skill at `skills/design-inspo/SKILL.md` documents both paths. Refresh any separately installed copy from that updated file. The local `inspo` CLI is no longer part of this project.

## Publish later changes

Manage references through `npm run dev`. Commit the catalog records, media, taxonomy, and generated local index together. Push the production branch to trigger a new Cloudflare build.

The website, MCP tools, and JSON API read the same deployed snapshot. Uncommitted or unpublished local changes do not appear remotely. Local notes and analysis errors never enter the published snapshot. Notes committed to a public Git repository are still visible through Git.

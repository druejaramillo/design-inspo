# Publish the catalog without hosting its editor

## Goal and scope

Keep catalog management in the local web app. Let public agents search the published catalog through remote MCP or JSON without a checkout. Remove the local CLI. Prepare the repository for Cloudflare without deploying it.

The work covers the shared data model, static exporter, shared queries, Worker, browser mode, agent skill, and deployment instructions. No catalog entries, media, analysis credentials, DNS, or remote resources are to be changed.

## Workflow

- [x] Read the Principles section of the poteto-mode skill.
- [x] Phase A: Frame.
- [x] Phase B: Design the workflow.
- [x] Phase C: Run the loop.
- [x] Phase D: Keep the audit trail.
- [x] Phase E: Verify and hand back.

### Throughput checkpoint

- Blocking first steps. Check SDK support, record the existing tests, and define the public data shape before changing consumers.
- Independent workstreams. Query, export, Worker, and browser changes share contracts and will run in sequence. Independent read-only inspections can run together.
- Shared mutable state. One owner edits this checkout. Tests use disposable catalogs. The real catalog is read-only during verification.
- Smallest safe decomposition. Verify the public snapshot and queries first, then the Worker transports, then the browser and CLI removal, then the built artifact.

Herdr is not active. Independent design runners, delegated implementation, and cross-model review are unavailable. Direct implementation and self-review do not satisfy those independent gates. The user later authorized a commit and push. Deployment and PR publication remain outside scope.

## Starting behavior

`server/catalog.ts` owns local JSON records and media. `server/index.ts` exposes management routes on loopback. `server/context.ts` contains pure tag and context queries. `scripts/export-static.ts` copies every record to the public build. `src/App.tsx` infers static mode from API failure. `bin/inspo.mjs` launches the repository-local CLI through `tsx`.

## Design choice

| Candidate | Benefit | Cost | Decision |
| --- | --- | --- | --- |
| Local query logic behind REST, with MCP calling REST | One external API contract | Internal HTTP calls and error adaptation for a single Worker | Rejected |
| Shared query functions called directly by browser, REST, and MCP | One query implementation and no internal network calls | Each transport needs a small boundary adapter | Selected |

This is a parent comparison, not an independent arena result.

### Data and ownership

- `CatalogItem` remains the editable local record.
- `PublishedCatalogItem` is an allowlist projection with no private notes, analysis error, capture metadata, or local diagnostic fields.
- `PublishedCatalog` contains a format version, content-derived generation time, taxonomy, and public items.
- One public snapshot replaces the copied directory of raw records. Only referenced catalog media accompanies it.
- Shared query functions own tag matching, overview counts, result limits, and context generation.
- Remote references carry absolute image URLs. Individual MCP inspection can include a size-limited saved image.
- The production browser is explicitly read-only. Development mode uses the local management API and does not fall back to a stale snapshot.
- The Worker owns only public reads. Its MCP and JSON adapters share query functions and never import local storage or analysis modules.

### Implementation units

1. Add public snapshot and shared query tests. Implement the allowlist exporter and move query ownership to `shared/`.
2. Add the Worker, MCP SDK integration, JSON API, input validation, and transport tests.
3. Switch the published browser to explicit read-only mode. Remove the CLI and update the skill and documentation.
4. Build and inspect the real output. Verify MCP discovery and calls over HTTP in local workerd. Verify public browsing and disposable local management in a browser.

## Definition of done

- Public exports omit private fields at every path, including after a rebuild that removes an item.
- MCP tools list and call successfully through Streamable HTTP without local catalog access.
- JSON and MCP preserve AND and OR matching, bounded references, and honest no-match results.
- Public image URLs resolve. Unknown API paths and forbidden writes fail instead of returning the app shell.
- Production browsing renders details, filters, and context without management controls or write requests.
- The local web UI can import, edit, and delete a disposable reference.
- No local CLI source, package entry point, or agent instruction remains.
- Tests, project type checks, build, and local Worker packaging pass. No deployment is performed.

## Evidence

The decision trail is `docs/remote-catalog-decisions.tsv`.

Verified commands:

- `npm test -- --maxWorkers=2 --no-file-parallelism` passes all 81 tests.
- `npm run typecheck` passes the browser, local server, and Worker projects.
- `npm run check:worker` builds and packages the Worker with a dry run.
- `npm run verify:published` checks the built snapshot and all four tools over HTTP in real local workerd from outside the checkout.
- `git diff --check` passes. `git diff --exit-code -- catalog` confirms that catalog data is unchanged.

A real browser verified public desktop and mobile browsing, search, tag filters, detail inspection, copied direction, no management controls, and no write requests. A disposable local catalog verified image import, title and note edits, tags, and deletion. The browser report is `/tmp/design-inspo-ui-evidence/report.json`. Screenshots are in `/tmp/pi-web-screenshot-UZYO9Q/`. These local evidence files belong to this run; the Worker verification script is the reusable project check.

## Attention

Independent model review was unavailable. Self-review is not an independent verdict.

`npm run validate` still reports the pre-existing unknown tag `gradient-rich` on `untitled-from-cdn-dribbble-com-e2f8b68b`. Catalog data was not changed to hide the finding.

The dependency audit reports pre-existing advisories in unchanged local-app and development packages. Zod was updated to 4.6.7 for public request validation. No forced major upgrades were made.

There is no configured project linter or formatter. Those automated checks were unavailable. The design detector reported two existing Arial warnings; the visual design was intentionally preserved.

Cloudflare authentication, DNS, remote deployment, and PR publication were not performed. The user subsequently authorized committing and pushing the verified implementation.

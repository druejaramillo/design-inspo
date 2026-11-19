import { ZodError } from "zod";
import { buildCatalogContext, buildCatalogOverview, catalogSearchSchema, searchCatalog } from "../shared/catalog-query.js";
import { handleCatalogMcp } from "./catalog-mcp.js";

import { publishedItemDetails, readPublishedCatalog, type CatalogWorkerEnv } from "./published-catalog.js";

function catalogJson(value: unknown, status = 200, headers?: Record<string, string>) {
  return Response.json(value, {
    status,
    headers: { "access-control-allow-origin": "*", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers },
  });
}

async function handleCatalogApi(request: Request, env: CatalogWorkerEnv) {
  const url = new URL(request.url);
  const itemRoute = url.pathname.match(/^\/api\/items\/([a-z0-9-]+)$/);
  if (!["/api/health", "/api/overview", "/api/search", "/api/context", "/api/taxonomy"].includes(url.pathname) && !itemRoute) {
    return catalogJson({ error: "Catalog API route not found." }, 404);
  }
  const filters = {
    tags: (url.searchParams.get("tags") ?? "").split(",").map((tag) => tag.trim()).filter(Boolean),
    mode: url.searchParams.get("mode") ?? "and",
  };
  const query = catalogSearchSchema.parse({
    ...filters,
    ...(url.searchParams.has("limit") ? { limit: Number(url.searchParams.get("limit")) } : {}),
    ...(url.searchParams.has("offset") ? { offset: Number(url.searchParams.get("offset")) } : {}),
  });
  const catalog = await readPublishedCatalog(request, env);
  switch (url.pathname) {
    case "/api/health": return catalogJson({ ok: true, mode: "published", generatedAt: catalog.generatedAt });
    case "/api/taxonomy": return catalogJson(catalog.taxonomy);
    case "/api/overview": return catalogJson(buildCatalogOverview(catalog.items, catalog.taxonomy, url.origin));
    case "/api/context": return catalogJson(buildCatalogContext(catalog.items, query.tags, query.mode, url.origin));
    case "/api/search": return catalogJson(searchCatalog(catalog.items, query, url.origin));
    default: {
      const item = publishedItemDetails(catalog, itemRoute![1], url.origin);
      return item ? catalogJson(item) : catalogJson({ error: "Catalog reference not found." }, 404);
    }
  }
}

export async function handlePublishedRequest(request: Request, env: CatalogWorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (url.pathname === "/mcp") return await handleCatalogMcp(request, env);
    if (url.pathname.startsWith("/mcp/")) return catalogJson({ error: "MCP endpoint not found. Use /mcp." }, 404);
    if (request.method === "OPTIONS" && (url.pathname === "/api" || url.pathname.startsWith("/api/"))) {
      return new Response(null, { status: 204, headers: {
        "access-control-allow-origin": "*", "access-control-allow-methods": "GET, HEAD, OPTIONS", "access-control-allow-headers": "Content-Type",
      } });
    }
    if (!["GET", "HEAD"].includes(request.method)) return catalogJson({ error: "The published catalog is read-only." }, 405, { allow: "GET, HEAD, OPTIONS" });
    const response = url.pathname === "/api" || url.pathname.startsWith("/api/")
      ? await handleCatalogApi(request, env)
      : await env.ASSETS.fetch(request);
    return request.method === "HEAD" ? new Response(null, { status: response.status, headers: response.headers }) : response;
  } catch (error) {
    if (error instanceof ZodError) return catalogJson({ error: "Invalid catalog request.", issues: error.issues.map((issue) => ({ path: issue.path, message: issue.message })) }, 400);
    console.error("Published catalog request failed", error);
    return catalogJson({ error: "Published catalog is unavailable. Try again after rebuilding the site." }, 503);
  }
}

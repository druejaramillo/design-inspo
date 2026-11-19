import { publishedCatalogSchema, type PublishedCatalog } from "../shared/published-catalog.js";
import { buildCatalogReference } from "../shared/catalog-query.js";

export interface CatalogWorkerEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
  MCP_ALLOWED_ORIGINS?: string;
}

export async function readPublishedCatalog(request: Request, env: CatalogWorkerEnv): Promise<PublishedCatalog> {
  const response = await env.ASSETS.fetch(new Request(new URL("/catalog/catalog.json", request.url)));
  if (!response.ok) throw new Error("Published catalog snapshot is unavailable.");
  const snapshot = publishedCatalogSchema.safeParse(await response.json());
  if (!snapshot.success) throw new Error("Published catalog snapshot is invalid.", { cause: snapshot.error });
  return snapshot.data;
}

export function publishedItemDetails(catalog: PublishedCatalog, id: string, origin: string) {
  const item = catalog.items.find((candidate) => candidate.id === id);
  return item ? { ...item, ...buildCatalogReference(item, origin) } : null;
}

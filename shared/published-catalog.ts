import { z } from "zod";
import { itemSchema, taxonomySchema, type CatalogItem, type Taxonomy } from "./schema.js";

export const publishedCatalogItemSchema = itemSchema.pick({
  id: true,
  title: true,
  sourceUrl: true,
  sourceDomain: true,
  importedAt: true,
  media: true,
  manualTagIds: true,
  analysis: true,
  analysisStatus: true,
}).extend({
  media: itemSchema.shape.media.unwrap().extend({
    path: z.string().regex(/^catalog\/media\/[a-z0-9-]+\.(webp|jpeg|png)$/),
  }).nullable(),
});

export const publishedCatalogSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string().datetime().nullable(),
  taxonomy: taxonomySchema,
  items: z.array(publishedCatalogItemSchema),
});

export type PublishedCatalogItem = z.infer<typeof publishedCatalogItemSchema>;
export type PublishedCatalog = z.infer<typeof publishedCatalogSchema>;

/** A public snapshot uses an allowlist rather than copying editable records. */
export function buildPublishedCatalog(items: CatalogItem[], taxonomy: Taxonomy): PublishedCatalog {
  return publishedCatalogSchema.parse({
    version: 1,
    generatedAt: items.map((item) => item.updatedAt).sort().at(-1) ?? null,
    taxonomy,
    items: [...items].sort((a, b) => b.importedAt.localeCompare(a.importedAt)),
  });
}

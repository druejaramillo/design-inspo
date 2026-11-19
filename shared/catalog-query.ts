import { z } from "zod";
import type { PublishedCatalogItem } from "./published-catalog.js";
import type { Taxonomy } from "./schema.js";

export const catalogFilterSchema = z.object({
  tags: z.array(z.string().trim().min(1).max(80)).max(24).default([]).describe("Taxonomy tag IDs. Use inspo_overview to discover available tags."),
  mode: z.enum(["and", "or"]).default("and").describe("Match every requested tag with and, or at least one with or."),
}).strict();

export const catalogSearchSchema = catalogFilterSchema.extend({
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).max(1_000_000).default(0),
});

export type FilterMode = z.infer<typeof catalogFilterSchema>["mode"];
export type CatalogSearchQuery = z.infer<typeof catalogSearchSchema>;
export type CatalogReference = ReturnType<typeof buildCatalogReference>;
export type CatalogContextOutput = ReturnType<typeof buildCatalogContext>;

export function catalogItemTagIds(item: Pick<PublishedCatalogItem, "manualTagIds" | "analysis">) {
  return [...new Set([...item.manualTagIds, ...(item.analysis?.suggestedTagIds ?? [])])];
}

export function matchesCatalogTags(item: Pick<PublishedCatalogItem, "manualTagIds" | "analysis">, tagIds: string[], mode: FilterMode) {
  if (!tagIds.length) return true;
  const tags = new Set(catalogItemTagIds(item));
  return mode === "and" ? tagIds.every((tag) => tags.has(tag)) : tagIds.some((tag) => tags.has(tag));
}

export function buildCatalogReference(item: PublishedCatalogItem, origin: string) {
  return {
    id: item.id,
    title: item.title,
    tags: catalogItemTagIds(item),
    sourceUrl: item.sourceUrl,
    imageUrl: item.media ? new URL(`/${item.media.path}`, origin).href : null,
  };
}

export function buildCatalogOverview(items: PublishedCatalogItem[], taxonomy: Taxonomy, origin: string, limit = 8) {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const tag of catalogItemTagIds(item)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return {
    itemCount: items.length,
    analyzedItemCount: items.filter((item) => item.analysis).length,
    tagGroups: taxonomy.groups
      .map((group) => ({
        ...group,
        tags: group.tags
          .map((tag) => ({ ...tag, count: counts.get(tag.id) ?? 0 }))
          .filter((tag) => tag.count > 0)
          .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
      }))
      .filter((group) => group.tags.length > 0),
    recentReferences: items.slice(0, limit).map((item) => buildCatalogReference(item, origin)),
  };
}

export function searchCatalog(items: PublishedCatalogItem[], query: CatalogSearchQuery, origin: string) {
  const matches = items.filter((item) => matchesCatalogTags(item, query.tags, query.mode));
  return {
    selectedTags: query.tags,
    mode: query.mode,
    count: matches.length,
    limit: query.limit,
    offset: query.offset,
    references: matches.slice(query.offset, query.offset + query.limit).map((item) => buildCatalogReference(item, origin)),
  };
}

/** Keep agent context bounded even when a caller requests more references. */
export function buildCatalogContext(items: PublishedCatalogItem[], tags: string[], mode: FilterMode, origin: string, limit = 6) {
  const matches = items.filter((item) => matchesCatalogTags(item, tags, mode));
  const analyses = matches.flatMap((item) => item.analysis ? [item.analysis] : []);
  const unique = (values: string[], max: number) => [...new Set(values)].slice(0, max);
  const palette = unique(analyses.flatMap((analysis) => analysis.palette.map((color) => color.hex)), 5);
  const style = unique(analyses.flatMap((analysis) => analysis.style), 5);
  const tone = unique(analyses.flatMap((analysis) => analysis.tone), 4);
  const layout = unique(analyses.flatMap((analysis) => analysis.layout), 4);
  const clauses = [
    style.length ? `Visual language: ${style.join(", ")}.` : "Use the selected visual references as the primary direction.",
    tone.length ? `Tone: ${tone.join(", ")}.` : null,
    layout.length ? `Composition: ${layout.join(", ")}.` : null,
    palette.length ? `Palette cues: ${palette.join(", ")}.` : null,
    "Use the references for hierarchy, texture, rhythm, and art direction rather than copying brands, logos, or exact layouts.",
  ].filter(Boolean);
  return {
    selectedTags: tags,
    mode,
    count: matches.length,
    prompt: matches.length ? clauses.join(" ") : "No catalog references match the selected tags.",
    references: matches.slice(0, Math.min(limit, 6)).map((item) => buildCatalogReference(item, origin)),
  };
}

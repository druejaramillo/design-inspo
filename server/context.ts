import type { CatalogItem } from "../shared/schema.js";

export type FilterMode = "and" | "or";

export type ContextOutput = {
  selectedTags: string[];
  mode: FilterMode;
  count: number;
  prompt: string;
  references: Array<{
    id: string;
    title: string;
    sourceUrl: string | null;
    imagePath: string | null;
  }>;
};

export function itemTagIds(item: Pick<CatalogItem, "manualTagIds" | "analysis">) {
  return [...new Set([...item.manualTagIds, ...(item.analysis?.suggestedTagIds ?? [])])];
}

export function matchesTags(item: Pick<CatalogItem, "manualTagIds" | "analysis">, tagIds: string[], mode: FilterMode) {
  if (!tagIds.length) return true;
  const tags = new Set(itemTagIds(item));
  return mode === "and" ? tagIds.every((tag) => tags.has(tag)) : tagIds.some((tag) => tags.has(tag));
}

export function buildContext(items: CatalogItem[], tags: string[], mode: FilterMode, limit = 6): ContextOutput {
  const matches = items.filter((item) => matchesTags(item, tags, mode));
  const analyses = matches.map((item) => item.analysis).filter((analysis): analysis is NonNullable<CatalogItem["analysis"]> => Boolean(analysis));
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
    prompt: clauses.join(" "),
    references: matches.slice(0, limit).map((item) => ({
      id: item.id,
      title: item.title,
      sourceUrl: item.sourceUrl,
      imagePath: item.media?.path ?? null,
    })),
  };
}

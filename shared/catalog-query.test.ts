import { describe, expect, it } from "vitest";
import { buildCatalogOverview, buildCatalogContext, matchesCatalogTags, searchCatalog, catalogSearchSchema } from "./catalog-query.js";
import type { CatalogItem, Taxonomy } from "./schema.js";

const origin = "https://catalog.example";
const item = (id: string, tags: string[], palette = ["#112233", "#eeddcc"]): CatalogItem => ({
  id, title: `Reference ${id}`, notes: "", sourceUrl: null, sourceDomain: null, captureMethod: "manual",
  importedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  media: { path: `catalog/media/${id}.webp`, width: 100, height: 100, format: "webp" },
  manualTagIds: tags, analysisStatus: "ready", analysisError: null,
  analysis: {
    version: 1, provider: "pi", analyzedAt: "2026-01-01T00:00:00.000Z", title: `Reference ${id}`,
    palette: palette.map((hex, index) => ({ hex, role: index ? "accent" : "background" })),
    style: ["editorial"], tone: ["warm"], layout: ["asymmetric"], typography: ["serif"], uiMotifs: [],
    notes: "A useful reference.", suggestedTagIds: [], heroPrompt: null,
  },
});

describe("catalog queries", () => {
  it("uses AND semantics across manual and suggested tags", () => {
    const reference = item("one", ["editorial"]);
    reference.analysis!.suggestedTagIds = ["warm"];
    expect(matchesCatalogTags(reference, ["editorial", "warm"], "and")).toBe(true);
    expect(matchesCatalogTags(reference, ["editorial", "brutalist"], "and")).toBe(false);
    expect(matchesCatalogTags(reference, ["editorial", "brutalist"], "or")).toBe(true);
    expect(matchesCatalogTags(reference, [], "and")).toBe(true);
  });

  it("creates a compact prompt and bounded references with usable image URLs", () => {
    const result = buildCatalogContext([item("one", ["editorial"]), item("two", ["editorial"])], ["editorial"], "and", origin, 1);
    expect(result.count).toBe(2);
    expect(result.references).toHaveLength(1);
    expect(result.prompt).toContain("Visual language: editorial.");
    expect(result.prompt).toContain("#112233");
    expect(result.references[0].imageUrl).toBe("https://catalog.example/catalog/media/one.webp");
    expect(result.references[0]).not.toHaveProperty("imagePath");
  });

  it("summarizes represented tags without double-counting manual and suggested tags", () => {
    const taxonomy: Taxonomy = { groups: [
      { id: "style", label: "Visual style", tags: [{ id: "editorial", label: "Editorial" }, { id: "brutalist", label: "Brutalist" }] },
      { id: "tone", label: "Tone", tags: [{ id: "warm", label: "Warm" }] },
    ] };
    const first = item("one", ["editorial"]);
    first.analysis!.suggestedTagIds = ["warm", "editorial"];
    const result = buildCatalogOverview([first, item("two", ["editorial"])], taxonomy, origin, 1);
    expect(result.itemCount).toBe(2);
    expect(result.analyzedItemCount).toBe(2);
    expect(result.tagGroups).toEqual([
      { id: "style", label: "Visual style", tags: [{ id: "editorial", label: "Editorial", count: 2 }] },
      { id: "tone", label: "Tone", tags: [{ id: "warm", label: "Warm", count: 1 }] },
    ]);
    expect(result.recentReferences).toEqual([expect.objectContaining({ id: "one", tags: ["editorial", "warm"] })]);
  });

  it("paginates search results without changing the total match count", () => {
    const result = searchCatalog([item("one", ["warm"]), item("two", ["warm"])], catalogSearchSchema.parse({ tags: ["warm"], limit: 1, offset: 1 }), origin);
    expect(result.count).toBe(2);
    expect(result.references.map((reference) => reference.id)).toEqual(["two"]);
    expect(searchCatalog([], catalogSearchSchema.parse({}), origin).count).toBe(0);
  });

  it("reports a no-match result without presenting a generic prompt as reference evidence", () => {
    const result = buildCatalogContext([item("one", ["warm"])], ["unknown-tag"], "and", origin);
    expect(result).toMatchObject({ count: 0, references: [], prompt: "No catalog references match the selected tags." });
  });

  it("caps context references at six and handles items without images or analyses", () => {
    const references = Array.from({ length: 8 }, (_, index) => item(`item-${index}`, []));
    references[0].media = null;
    references[0].analysis = null;
    const result = buildCatalogContext(references, [], "and", origin, 100);
    expect(result.count).toBe(8);
    expect(result.references).toHaveLength(6);
    expect(result.references[0].imageUrl).toBeNull();
  });

  it.each([{ mode: "invalid" }, { limit: 101 }, { limit: -1 }, { offset: -1 }, { tags: Array(25).fill("warm") }, { tags: [""] }])("rejects an invalid query %j", (query) => {
    expect(catalogSearchSchema.safeParse(query).success).toBe(false);
  });
});

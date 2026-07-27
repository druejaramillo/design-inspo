import { describe, expect, it } from "vitest";
import { buildCatalogOverview, buildContext, matchesTags } from "./context.js";
import type { CatalogItem, Taxonomy } from "../shared/schema.js";

const item = (id: string, tags: string[], palette = ["#112233", "#eeddcc"]): CatalogItem => ({
  id,
  title: `Reference ${id}`,
  notes: "",
  sourceUrl: null,
  sourceDomain: null,
  captureMethod: "manual",
  importedAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  media: null,
  manualTagIds: tags,
  analysisStatus: "ready",
  analysisError: null,
  analysis: {
    version: 1,
    provider: "opencode",
    analyzedAt: "2026-01-01T00:00:00.000Z",
    title: `Reference ${id}`,
    palette: palette.map((hex, index) => ({ hex, role: index ? "accent" : "background" })),
    style: ["editorial"],
    tone: ["warm"],
    layout: ["asymmetric"],
    typography: ["serif"],
    uiMotifs: [],
    notes: "A useful reference.",
    suggestedTagIds: [],
    heroPrompt: null,
  },
});

describe("catalog context", () => {
  it("uses AND semantics across manual and suggested tags", () => {
    const reference = item("one", ["editorial"], ["#112233", "#eeddcc"]);
    reference.analysis!.suggestedTagIds = ["warm"];
    expect(matchesTags(reference, ["editorial", "warm"], "and")).toBe(true);
    expect(matchesTags(reference, ["editorial", "brutalist"], "and")).toBe(false);
  });

  it("creates a compact prompt and bounded references", () => {
    const result = buildContext([item("one", ["editorial"]), item("two", ["editorial"])], ["editorial"], "and", 1);
    expect(result.count).toBe(2);
    expect(result.references).toHaveLength(1);
    expect(result.prompt).toContain("Visual language: editorial.");
    expect(result.prompt).toContain("#112233");
  });

  it("summarizes available tags and recent references for discovery", () => {
    const taxonomy: Taxonomy = {
      groups: [
        {
          id: "style",
          label: "Visual style",
          tags: [
            { id: "editorial", label: "Editorial" },
            { id: "brutalist", label: "Brutalist" },
          ],
        },
        {
          id: "tone",
          label: "Tone",
          tags: [{ id: "warm", label: "Warm" }],
        },
      ],
    };
    const first = item("one", ["editorial"]);
    first.analysis!.suggestedTagIds = ["warm"];
    const result = buildCatalogOverview([first, item("two", ["editorial"])], taxonomy, 1);

    expect(result.itemCount).toBe(2);
    expect(result.analyzedItemCount).toBe(2);
    expect(result.tagGroups).toEqual([
      { id: "style", label: "Visual style", tags: [{ id: "editorial", label: "Editorial", count: 2 }] },
      { id: "tone", label: "Tone", tags: [{ id: "warm", label: "Warm", count: 1 }] },
    ]);
    expect(result.recentReferences).toEqual([
      expect.objectContaining({ id: "one", tags: ["editorial", "warm"] }),
    ]);
  });
});

import { describe, expect, it } from "vitest";
import { buildContext, matchesTags } from "./context.js";
import type { CatalogItem } from "../shared/schema.js";

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
});

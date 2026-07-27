import { join } from "node:path";
import {
  analysisErrorMessage,
  analysisStatusAfterError,
  analyzeItem,
  type AnalysisProvider,
} from "./analysis.js";
import { getItem, getTaxonomy, paths, rebuildIndex, writeItem } from "./catalog.js";

export async function runCatalogAnalysis(id: string, provider: AnalysisProvider, signal?: AbortSignal) {
  const item = await getItem(id);
  if (!item.media) throw new Error("This item needs an image before it can be analyzed.");
  try {
    const analysis = await analyzeItem(item, join(paths.root, item.media.path), await getTaxonomy(), provider, signal);
    const current = await getItem(id);
    const updated = await writeItem({
      ...current,
      title: analysis.title,
      analysis,
      analysisStatus: "ready",
      analysisError: null,
      updatedAt: new Date().toISOString(),
    });
    await rebuildIndex();
    return updated;
  } catch (error) {
    const current = await getItem(id);
    await writeItem({
      ...current,
      analysisStatus: analysisStatusAfterError(error),
      analysisError: analysisErrorMessage(error),
      updatedAt: new Date().toISOString(),
    });
    await rebuildIndex();
    throw error;
  }
}

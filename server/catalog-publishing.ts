import { copyFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { publishedCatalogSchema, type PublishedCatalog } from "../shared/published-catalog.js";

/** Old exports can contain private records, so rebuilds must replace the directory. */
export async function writePublishedCatalog(catalog: PublishedCatalog, sourceRoot: string, destination: string) {
  const snapshot = publishedCatalogSchema.parse(catalog);
  await mkdir(dirname(destination), { recursive: true });
  const staging = await mkdtemp(join(dirname(destination), ".catalog-"));
  try {
    await mkdir(join(staging, "media"));
    const mediaPaths = new Set(snapshot.items.flatMap((item) => item.media ? [item.media.path] : []));
    for (const mediaPath of mediaPaths) {
      await copyFile(join(sourceRoot, mediaPath), join(staging, "media", basename(mediaPath)));
    }
    await writeFile(join(staging, "catalog.json"), `${JSON.stringify(snapshot, null, 2)}\n`);
    await rm(destination, { recursive: true, force: true });
    await rename(staging, destination);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

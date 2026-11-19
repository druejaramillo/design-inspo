import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writePublishedCatalog } from "../server/catalog-publishing.js";
import { itemSchema } from "./schema.js";
import { buildPublishedCatalog, publishedCatalogSchema } from "./published-catalog.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const reference = () => itemSchema.parse({
  id: "one", title: "One", notes: "PRIVATE_NOTE_SENTINEL", sourceUrl: null, sourceDomain: null,
  captureMethod: "manual", importedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
  media: { path: "catalog/media/one.webp", width: 1, height: 1, format: "webp" },
  manualTagIds: [], analysis: null, analysisStatus: "failed", analysisError: "PRIVATE_ERROR_SENTINEL",
});

describe("published catalog", () => {
  it("omits private fields with an allowlist and preserves stable content timestamps", () => {
    const snapshot = buildPublishedCatalog([reference()], { groups: [] });
    const json = JSON.stringify(snapshot);
    expect(json).not.toContain("PRIVATE_NOTE_SENTINEL");
    expect(json).not.toContain("PRIVATE_ERROR_SENTINEL");
    expect(snapshot.items[0]).not.toHaveProperty("notes");
    expect(snapshot.items[0]).not.toHaveProperty("analysisError");
    expect(snapshot.items[0]).not.toHaveProperty("captureMethod");
    expect(snapshot.generatedAt).toBe("2026-01-02T00:00:00.000Z");
    expect(snapshot).toEqual(buildPublishedCatalog([reference()], { groups: [] }));
  });

  it("rejects media paths outside the public media directory", () => {
    const item = reference();
    item.media!.path = "catalog/media/../../.env";
    expect(() => buildPublishedCatalog([item], { groups: [] })).toThrow();
  });

  it("exports only referenced media and removes raw records and stale assets on rebuild", async () => {
    const root = await mkdtemp(join(tmpdir(), "inspo-publish-"));
    roots.push(root);
    await mkdir(join(root, "catalog/media"), { recursive: true });
    await writeFile(join(root, "catalog/media/one.webp"), "public image");
    await writeFile(join(root, "catalog/media/unreferenced.webp"), "unreferenced image");
    const destination = join(root, "public/catalog");
    await mkdir(join(destination, "items"), { recursive: true });
    await writeFile(join(destination, "items/old.json"), "PRIVATE_NOTE_SENTINEL");
    const snapshot = buildPublishedCatalog([reference()], { groups: [] });
    await writePublishedCatalog(snapshot, root, destination);
    expect((await readdir(destination)).sort()).toEqual(["catalog.json", "media"]);
    expect(await readdir(join(destination, "media"))).toEqual(["one.webp"]);
    const exported = await readFile(join(destination, "catalog.json"), "utf8");
    expect(exported).not.toContain("PRIVATE_");
    expect(publishedCatalogSchema.parse(JSON.parse(exported))).toEqual(snapshot);
    await writePublishedCatalog(buildPublishedCatalog([], { groups: [] }), root, destination);
    expect(await readdir(join(destination, "media"))).toEqual([]);
  });

  it("keeps the previous public snapshot when a referenced image is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "inspo-publish-"));
    roots.push(root);
    const destination = join(root, "public/catalog");
    const previous = buildPublishedCatalog([], { groups: [] });
    await writePublishedCatalog(previous, root, destination);
    await expect(writePublishedCatalog(buildPublishedCatalog([reference()], { groups: [] }), root, destination)).rejects.toThrow();
    expect(JSON.parse(await readFile(join(destination, "catalog.json"), "utf8"))).toEqual(previous);
  });
});

import { existsSync } from "node:fs";
import { join } from "node:path";
import { analyzeItem, type AnalysisProvider } from "../server/analysis.js";
import { createItem, getAllItems, getItem, getTaxonomy, importFromUrl, paths, rebuildIndex, writeItem } from "../server/catalog.js";
import { buildContext, matchesTags, type FilterMode } from "../server/context.js";

function argumentsFor(flag: string) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function tagsFromArguments() {
  return (argumentsFor("--tags") ?? "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function print(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usage() {
  console.log(`Usage:
  inspo search --tags "editorial,warm" [--mode and|or]
  inspo context --tags "editorial,warm" [--mode and|or]
  inspo import <image-file-or-url> [--title "..."]
  inspo analyze <item-id> [--provider opencode|openai]
  inspo validate`);
}

async function importFile(file: string, title?: string) {
  const { readFile } = await import("node:fs/promises");
  const buffer = await readFile(file);
  return createItem({
    title: title || file.split("/").pop()?.replace(/\.[^.]+$/, "") || "Untitled inspiration",
    buffer,
    captureMethod: "manual",
  });
}

async function validate() {
  const items = await getAllItems();
  const taxonomy = await getTaxonomy();
  const validTagIds = new Set(taxonomy.groups.flatMap((group) => group.tags.map((tag) => tag.id)));
  const issues: string[] = [];
  for (const item of items) {
    if (item.media && !existsSync(join(paths.root, item.media.path))) issues.push(`${item.id}: missing ${item.media.path}`);
    for (const tag of [...item.manualTagIds, ...(item.analysis?.suggestedTagIds ?? [])]) {
      if (!validTagIds.has(tag)) issues.push(`${item.id}: unknown tag '${tag}'`);
    }
  }
  await rebuildIndex();
  if (issues.length) {
    console.error(issues.join("\n"));
    process.exitCode = 1;
    return;
  }
  console.log(`Catalog valid: ${items.length} item${items.length === 1 ? "" : "s"}.`);
}

async function main() {
  const command = process.argv[2];
  if (!command || command === "help" || command === "--help") return usage();
  const mode: FilterMode = argumentsFor("--mode") === "or" ? "or" : "and";

  if (command === "search") {
    const tags = tagsFromArguments();
    const items = (await getAllItems()).filter((item) => matchesTags(item, tags, mode));
    print(
      items.map((item) => ({
        id: item.id,
        title: item.title,
        tags: [...item.manualTagIds, ...(item.analysis?.suggestedTagIds ?? [])],
        sourceUrl: item.sourceUrl,
        imagePath: item.media?.path ?? null,
      })),
    );
    return;
  }

  if (command === "context") {
    print(buildContext(await getAllItems(), tagsFromArguments(), mode));
    return;
  }

  if (command === "import") {
    const source = process.argv[3];
    if (!source) throw new Error("Provide an image path or URL to import.");
    const item = /^https?:\/\//i.test(source)
      ? await importFromUrl(source, argumentsFor("--title"))
      : await importFile(source, argumentsFor("--title"));
    print(item);
    return;
  }

  if (command === "analyze") {
    const id = process.argv[3];
    if (!id) throw new Error("Provide an item ID to analyze.");
    const item = await getItem(id);
    if (!item.media) throw new Error("This item needs an image before analysis.");
    const provider: AnalysisProvider = argumentsFor("--provider") === "openai" ? "openai" : "opencode";
    const analysis = await analyzeItem(item, join(paths.root, item.media.path), await getTaxonomy(), provider);
    const updated = await writeItem({ ...item, title: analysis.title, analysis, analysisStatus: "ready", updatedAt: new Date().toISOString() });
    await rebuildIndex();
    print(updated);
    return;
  }

  if (command === "validate") return validate();
  usage();
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

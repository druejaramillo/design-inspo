import { existsSync } from "node:fs";
import { join } from "node:path";
import { getAllItems, getTaxonomy, paths } from "../server/catalog.js";

const [items, taxonomy] = await Promise.all([getAllItems(), getTaxonomy()]);
const validTagIds = new Set(taxonomy.groups.flatMap((group) => group.tags.map((tag) => tag.id)));
const issues: string[] = [];
for (const item of items) {
  if (item.media && !existsSync(join(paths.root, item.media.path))) issues.push(`${item.id}: missing ${item.media.path}`);
  for (const tag of [...item.manualTagIds, ...(item.analysis?.suggestedTagIds ?? [])]) {
    if (!validTagIds.has(tag)) issues.push(`${item.id}: unknown tag '${tag}'`);
  }
}
if (issues.length) {
  console.error(issues.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Catalog valid: ${items.length} items.`);
}

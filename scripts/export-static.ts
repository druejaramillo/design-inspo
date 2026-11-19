import { fileURLToPath } from "node:url";
import { getAllItems, getTaxonomy, paths } from "../server/catalog.js";
import { writePublishedCatalog } from "../server/catalog-publishing.js";
import { buildPublishedCatalog } from "../shared/published-catalog.js";

const [items, taxonomy] = await Promise.all([getAllItems(), getTaxonomy()]);
const destination = fileURLToPath(new URL("../public/catalog", import.meta.url));
await writePublishedCatalog(buildPublishedCatalog(items, taxonomy), paths.root, destination);

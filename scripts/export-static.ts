import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { paths, rebuildIndex } from "../server/catalog.js";

// Vite copies public/ verbatim, making the committed catalog browseable on static hosting.
await rebuildIndex();
const destination = join(paths.root, "public", "catalog");
await mkdir(join(paths.root, "public"), { recursive: true });
await rm(destination, { recursive: true, force: true });
await cp(paths.catalog, destination, { recursive: true });

import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import {
  itemSchema,
  taxonomySchema,
  type CatalogIndex,
  type CatalogItem,
  type CatalogSummary,
  type Taxonomy,
} from "../shared/schema.js";

const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const root = resolve(process.env.INSPO_ROOT ?? packageRoot);
export const paths = {
  root,
  catalog: join(root, "catalog"),
  items: join(root, "catalog", "items"),
  media: join(root, "catalog", "media"),
  index: join(root, "catalog", "index.json"),
  taxonomy: join(root, "catalog", "taxonomy.json"),
  dist: join(root, "dist"),
};

type SourcePreview = {
  title: string | null;
  sourceUrl: string;
  sourceImageUrl: string | null;
  buffer: Buffer | null;
};

export type CreateItemInput = {
  title?: string;
  sourceUrl?: string | null;
  sourceImageUrl?: string | null;
  buffer?: Buffer | null;
  captureMethod: CatalogItem["captureMethod"];
};

function timestamp() {
  return new Date().toISOString();
}

function idFromTitle(title: string) {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${slug || "inspiration"}-${randomUUID().slice(0, 8)}`;
}

async function writeJsonAtomic(file: string, value: unknown) {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, file);
}

async function ensureCatalogDirectories() {
  await Promise.all([mkdir(paths.items, { recursive: true }), mkdir(paths.media, { recursive: true })]);
}

function sourceDomain(url: string | null | undefined) {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function sourcePlatformTag(url: string | null | undefined) {
  const domain = sourceDomain(url);
  if (!domain) return null;
  if (domain.endsWith("dribbble.com")) return "dribbble";
  if (domain.endsWith("pinterest.com") || domain.endsWith("pin.it")) return "pinterest";
  if (domain.endsWith("craftwork.design")) return "craftwork";
  if (domain.endsWith("landing.love")) return "landing-love";
  if (domain.endsWith("sasspo.com")) return "sasspo";
  return null;
}

function titleFromUrl(url: string | null | undefined) {
  const domain = sourceDomain(url);
  return domain ? `Untitled from ${domain}` : "Untitled inspiration";
}

export async function getTaxonomy(): Promise<Taxonomy> {
  return taxonomySchema.parse(JSON.parse(await readFile(paths.taxonomy, "utf8")));
}

export async function getAllItems(): Promise<CatalogItem[]> {
  await ensureCatalogDirectories();
  const files = (await readdir(paths.items)).filter((file) => file.endsWith(".json"));
  const items = await Promise.all(
    files.map(async (file) => itemSchema.parse(JSON.parse(await readFile(join(paths.items, file), "utf8")))),
  );
  return items.sort((a, b) => b.importedAt.localeCompare(a.importedAt));
}

export async function getItem(id: string) {
  return itemSchema.parse(JSON.parse(await readFile(join(paths.items, `${id}.json`), "utf8")));
}

export async function writeItem(item: CatalogItem) {
  await ensureCatalogDirectories();
  const parsed = itemSchema.parse(item);
  await writeJsonAtomic(join(paths.items, `${parsed.id}.json`), parsed);
  return parsed;
}

function summaryFor(item: CatalogItem): CatalogSummary {
  return {
    id: item.id,
    title: item.title,
    sourceUrl: item.sourceUrl,
    sourceDomain: item.sourceDomain,
    importedAt: item.importedAt,
    media: item.media,
    manualTagIds: item.manualTagIds,
    analysis: item.analysis,
    analysisStatus: item.analysisStatus,
    analysisError: item.analysisError,
  };
}

export async function rebuildIndex(): Promise<CatalogIndex> {
  const items = await getAllItems();
  const index: CatalogIndex = {
    // Derive this value from catalog content so rebuilding an unchanged catalog does not create a Git diff.
    generatedAt: items.map((item) => item.updatedAt).sort().at(-1) ?? null,
    items: items.map(summaryFor),
  };
  await writeJsonAtomic(paths.index, index);
  return index;
}

export async function getIndex(): Promise<CatalogIndex> {
  if (!existsSync(paths.index)) return rebuildIndex();
  try {
    return JSON.parse(await readFile(paths.index, "utf8")) as CatalogIndex;
  } catch {
    return rebuildIndex();
  }
}

async function saveMedia(id: string, buffer: Buffer) {
  const image = sharp(buffer, { failOn: "none" }).rotate();
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height) throw new Error("The imported file is not a readable image.");

  const filename = `${id}.webp`;
  const output = await image
    .resize({ width: 2200, height: 2200, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 88 })
    .toBuffer({ resolveWithObject: true });
  await writeFile(join(paths.media, filename), output.data);

  return {
    path: `catalog/media/${filename}`,
    width: output.info.width,
    height: output.info.height,
    format: "webp" as const,
  };
}

export async function createItem(input: CreateItemInput) {
  await ensureCatalogDirectories();
  const source = input.sourceUrl ?? null;
  const id = idFromTitle(input.title || titleFromUrl(source));
  const now = timestamp();
  const platformTag = sourcePlatformTag(source);
  const item: CatalogItem = {
    id,
    title: input.title?.trim() || titleFromUrl(source),
    notes: "",
    sourceUrl: source,
    sourceImageUrl: input.sourceImageUrl ?? undefined,
    sourceDomain: sourceDomain(source),
    captureMethod: input.captureMethod,
    importedAt: now,
    updatedAt: now,
    media: input.buffer ? await saveMedia(id, input.buffer) : null,
    manualTagIds: platformTag ? [platformTag] : [],
    analysis: null,
    analysisStatus: input.buffer ? "pending" : "not-requested",
    analysisError: null,
  };
  await writeItem(item);
  await rebuildIndex();
  return item;
}

export async function updateItem(
  id: string,
  patch: Partial<Pick<CatalogItem, "title" | "notes" | "manualTagIds" | "sourceUrl">>,
) {
  const current = await getItem(id);
  const nextSourceUrl = patch.sourceUrl === undefined ? current.sourceUrl : patch.sourceUrl;
  const platformTag = sourcePlatformTag(nextSourceUrl);
  const sourceTags = ["dribbble", "pinterest", "craftwork", "landing-love", "sasspo"];
  const manualTagIds = [...new Set((patch.manualTagIds ?? current.manualTagIds).filter((tag) => !sourceTags.includes(tag)))];
  if (platformTag && !manualTagIds.includes(platformTag)) manualTagIds.push(platformTag);

  const next = itemSchema.parse({
    ...current,
    ...patch,
    sourceDomain: sourceDomain(nextSourceUrl),
    manualTagIds,
    updatedAt: timestamp(),
  });
  await writeItem(next);
  await rebuildIndex();
  return next;
}

export async function deleteItem(id: string) {
  const item = await getItem(id);
  await unlink(join(paths.items, `${id}.json`));
  if (item.media) {
    await unlink(join(paths.root, item.media.path)).catch(() => undefined);
  }
  await rebuildIndex();
}

function assertSafeRemoteUrl(rawUrl: string) {
  const url = new URL(rawUrl);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only http and https URLs can be imported.");
  const hostname = url.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".local") ||
    hostname === "::1" ||
    /^127\./.test(hostname) ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^169\.254\./.test(hostname)
  ) {
    throw new Error("Local-network URLs cannot be imported.");
  }
  return url;
}

async function fetchBuffer(response: Response) {
  const length = Number(response.headers.get("content-length") || 0);
  if (length > 12 * 1024 * 1024) throw new Error("The remote image is larger than 12 MB.");
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > 12 * 1024 * 1024) throw new Error("The remote image is larger than 12 MB.");
  return data;
}

async function fetchRemote(url: string) {
  assertSafeRemoteUrl(url);
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": "FieldNotesDesignCatalog/0.1 (+local personal catalog)",
      accept: "image/avif,image/webp,image/png,image/jpeg,text/html;q=0.9,*/*;q=0.1",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Could not retrieve the URL (${response.status}).`);
  return response;
}

function metaValue(html: string, key: string) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`, "i"),
  ];
  const result = patterns.map((pattern) => html.match(pattern)?.[1]).find(Boolean);
  return result?.replace(/&amp;/g, "&") ?? null;
}

function pageTitle(html: string) {
  return metaValue(html, "og:title") ?? html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? null;
}

export async function inspectRemoteUrl(rawUrl: string): Promise<SourcePreview> {
  const url = assertSafeRemoteUrl(rawUrl).toString();
  const response = await fetchRemote(url);
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";

  if (contentType.startsWith("image/")) {
    return { title: null, sourceUrl: response.url, sourceImageUrl: response.url, buffer: await fetchBuffer(response) };
  }

  if (!contentType.includes("html")) {
    throw new Error("The URL does not point to an image or HTML page.");
  }
  const html = await response.text();
  const imageReference = metaValue(html, "og:image") ?? metaValue(html, "twitter:image");
  if (!imageReference) {
    return { title: pageTitle(html), sourceUrl: response.url, sourceImageUrl: null, buffer: null };
  }
  const sourceImageUrl = new URL(imageReference, response.url).toString();
  try {
    const imageResponse = await fetchRemote(sourceImageUrl);
    if (!imageResponse.headers.get("content-type")?.toLowerCase().startsWith("image/")) {
      return { title: pageTitle(html), sourceUrl: response.url, sourceImageUrl, buffer: null };
    }
    return {
      title: pageTitle(html),
      sourceUrl: response.url,
      sourceImageUrl,
      buffer: await fetchBuffer(imageResponse),
    };
  } catch {
    return { title: pageTitle(html), sourceUrl: response.url, sourceImageUrl, buffer: null };
  }
}

export async function importFromUrl(url: string, title?: string) {
  const preview = await inspectRemoteUrl(url);
  return createItem({
    title: title?.trim() || preview.title || undefined,
    sourceUrl: preview.sourceUrl,
    sourceImageUrl: preview.sourceImageUrl,
    buffer: preview.buffer,
    captureMethod: "url",
  });
}

export function mediaFileName(path: string) {
  return basename(path, extname(path));
}

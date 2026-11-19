import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { publishedCatalogSchema } from "../shared/published-catalog.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), "inspo-worker-"));
const originalCwd = process.cwd();
const reservation = createServer();
await new Promise<void>((resolve, reject) => {
  reservation.once("error", reject);
  reservation.listen(0, "127.0.0.1", resolve);
});
const address = reservation.address();
assert(address && typeof address !== "string");
const port = address.port;
await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
const origin = `http://127.0.0.1:${port}`;
const worker = spawn(process.execPath, [
  join(root, "node_modules/wrangler/bin/wrangler.js"), "dev", "--local", "--ip", "127.0.0.1", "--port", String(port),
  "--inspector-port", "0", "--persist-to", join(scratch, "state"), "--no-show-interactive-dev-session", "--infer-origin-from-routes=false",
], {
  cwd: root, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
});
let logs = "";
worker.stdout.on("data", (chunk: Buffer) => { logs = `${logs}${chunk}`.slice(-100_000); });
worker.stderr.on("data", (chunk: Buffer) => { logs = `${logs}${chunk}`.slice(-100_000); });
let spawnError: Error | undefined;
worker.once("error", (error) => { spawnError = error; });
const exited = new Promise<void>((resolve) => worker.once("exit", () => resolve()));
const terminate = (signal: NodeJS.Signals) => {
  if (!worker.pid) return;
  try {
    if (process.platform === "win32") worker.kill(signal);
    else process.kill(-worker.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
};
const stopOnExit = () => terminate("SIGTERM");
process.once("exit", stopOnExit);
const interrupt = () => { terminate("SIGTERM"); process.exit(130); };
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const client = new Client({ name: "published-catalog-verification", version: "1.0.0" });

try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (spawnError) throw spawnError;
    if (worker.exitCode !== null) throw new Error(`Local Worker exited before readiness.\n${logs}`);
    try {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) { ready = true; break; }
    } catch {}
    await delay(500);
  }
  assert(ready, `Local Worker did not become ready.\n${logs}`);
  process.chdir(scratch);

  const snapshot = publishedCatalogSchema.parse(JSON.parse(await readFile(join(root, "dist/catalog/catalog.json"), "utf8")));
  assert.deepEqual((await readdir(join(root, "dist/catalog"))).sort(), ["catalog.json", "media"]);
  const published = await fetch(`${origin}/catalog/catalog.json`);
  const publicJson = await published.json() as { items: Record<string, unknown>[] };
  assert(published.ok);
  assert(publicJson.items.every((item) => !Object.hasOwn(item, "notes") && !Object.hasOwn(item, "analysisError")));

  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`));
  await client.connect(transport);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name), ["inspo_overview", "inspo_search", "inspo_context", "inspo_get_reference"]);
  assert(listed.tools.every((tool) => tool.annotations?.readOnlyHint));
  const overview = await client.callTool({ name: "inspo_overview", arguments: {} });
  assert(!overview.isError);
  assert.deepEqual(overview.structuredContent, await (await fetch(`${origin}/api/overview`)).json());
  assert.equal((overview.structuredContent as { itemCount: number }).itemCount, snapshot.items.length);
  const context = await client.callTool({ name: "inspo_context", arguments: { tags: ["nonexistent-verification-tag"] } });
  assert.deepEqual(context.structuredContent, await (await fetch(`${origin}/api/context?tags=nonexistent-verification-tag`)).json());
  assert.equal((context.structuredContent as { count: number }).count, 0);
  const search = await client.callTool({ name: "inspo_search", arguments: { limit: 1 } });
  assert.deepEqual(search.structuredContent, await (await fetch(`${origin}/api/search?limit=1`)).json());

  const firstImage = snapshot.items.find((item) => item.media);
  if (firstImage?.media) {
    const detail = await client.callTool({ name: "inspo_get_reference", arguments: { id: firstImage.id, includeImage: true } });
    assert(!detail.isError);
    const imageUrl = (detail.structuredContent as { imageUrl: string }).imageUrl;
    assert.equal(new URL(imageUrl).origin, origin);
    const image = await fetch(imageUrl);
    assert(image.ok && image.headers.get("content-type")?.startsWith("image/"));
    const imageBytes = (await image.arrayBuffer()).byteLength;
    if (imageBytes <= 2 * 1024 * 1024) assert(detail.content.some((content) => content.type === "image"));
    else assert(JSON.stringify(detail.content).includes("2 MiB inline limit"));
  } else console.log("No published images are available for the image inspection check.");

  for (const method of ["POST", "PATCH", "DELETE"]) {
    for (const path of ["/api/import", "/api/items/test", "/api/items/test/analyze", "/catalog/catalog.json", "/"]) {
      assert.equal((await fetch(`${origin}${path}`, { method })).status, 405, `${method} ${path} must fail`);
    }
  }
  for (const path of ["/api/unknown", "/api/items/missing-reference", "/catalog/items/old.json", "/catalog/index.json"]) {
    assert.equal((await fetch(`${origin}${path}`)).status, 404, `${path} must not expose old records or the app shell`);
  }
  assert.equal((await fetch(`${origin}/api/search?mode=invalid`)).status, 400);
  const head = await fetch(`${origin}/api/overview`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  console.log("Verified the built catalog, real workerd HTTP routes, all four MCP tools, public images, no-match results, and rejected writes from outside the checkout.");
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  await client.close().catch((error: unknown) => { console.error("MCP verification client cleanup failed", error); });
  process.chdir(originalCwd);
  terminate("SIGTERM");
  await Promise.race([exited, delay(3_000)]);
  terminate("SIGKILL");
  process.removeListener("exit", stopOnExit);
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  await rm(scratch, { recursive: true, force: true });
}

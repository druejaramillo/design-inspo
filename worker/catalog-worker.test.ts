import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { itemSchema } from "../shared/schema.js";
import { buildPublishedCatalog } from "../shared/published-catalog.js";
import { handlePublishedRequest } from "./catalog-worker.js";
import type { CatalogWorkerEnv } from "./published-catalog.js";

const origin = "https://catalog.example";
const taxonomy = { groups: [{ id: "style", label: "Style", tags: [
  { id: "editorial", label: "Editorial" }, { id: "warm", label: "Warm" }, { id: "unused", label: "Unused" },
] }] };
const items = [
  ["one", ["editorial", "warm"]], ["two", ["editorial"]], ["three", ["warm"]],
].map(([id, tags]) => itemSchema.parse({
  id, title: `Reference ${id}`, notes: "PRIVATE_NOTE_SENTINEL", sourceUrl: null, sourceDomain: null,
  captureMethod: "manual", importedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  media: { path: `catalog/media/${id}.webp`, width: 1, height: 1, format: "webp" },
  manualTagIds: tags, analysis: null, analysisStatus: "failed", analysisError: "PRIVATE_ERROR_SENTINEL",
}));
const snapshot = buildPublishedCatalog(items, taxonomy);
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  vi.restoreAllMocks();
});

function catalogEnvironment(): CatalogWorkerEnv {
  return { ASSETS: { fetch: vi.fn(async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path === "/catalog/catalog.json") return Response.json(snapshot);
    if (path.startsWith("/catalog/media/")) return new Response("saved image", { headers: { "content-type": "image/webp" } });
    if (path === "/") return new Response("<html>Field Notes</html>", { headers: { "content-type": "text/html" } });
    return new Response("Not found", { status: 404 });
  }) } };
}

function catalogRequest(path: string, env = catalogEnvironment(), init?: RequestInit) {
  return handlePublishedRequest(new Request(`${origin}${path}`, init), env);
}

async function catalogClient(env = catalogEnvironment()) {
  const client = new Client({ name: "catalog-test", version: "1.0.0" });
  clients.push(client);
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    fetch: async (input, init) => handlePublishedRequest(new Request(input, init), env),
  });
  await client.connect(transport);
  return client;
}

describe("published JSON API", () => {
  it("discovers represented tags and absolute image URLs", async () => {
    const response = await catalogRequest("/api/overview");
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(await response.json()).toMatchObject({
      itemCount: 3,
      tagGroups: [{ tags: [{ id: "editorial", count: 2 }, { id: "warm", count: 2 }] }],
      recentReferences: [expect.objectContaining({ imageUrl: `${origin}/catalog/media/one.webp` }), expect.anything(), expect.anything()],
    });
  });

  it("preserves AND and OR semantics and paginates without changing the count", async () => {
    expect(await (await catalogRequest("/api/search?tags=editorial,warm")).json()).toMatchObject({ count: 1, mode: "and" });
    expect(await (await catalogRequest("/api/search?tags=editorial,warm&mode=or&limit=1&offset=1")).json()).toMatchObject({
      count: 3, limit: 1, offset: 1, references: [{ id: "two" }],
    });
  });

  it("returns public details without private record fields", async () => {
    const response = await catalogRequest("/api/items/one");
    const text = await response.text();
    expect(text).not.toContain("PRIVATE_");
    const item = JSON.parse(text);
    expect(item).not.toHaveProperty("notes");
    expect(item).not.toHaveProperty("analysisError");
    expect(item).toMatchObject({ id: "one", imageUrl: `${origin}/catalog/media/one.webp` });
    expect((await catalogRequest("/api/items/missing")).status).toBe(404);
  });

  it("reports no-match context honestly and supports HEAD and preflight", async () => {
    expect(await (await catalogRequest("/api/context?tags=absent")).json()).toMatchObject({ count: 0, references: [], prompt: "No catalog references match the selected tags." });
    const head = await catalogRequest("/api/overview", undefined, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect((await catalogRequest("/api/search", undefined, { method: "OPTIONS" })).status).toBe(204);
  });

  it.each(["mode=invalid", "limit=101", "limit=NaN", "offset=-1", `tags=${Array(25).fill("warm").join(",")}`])("rejects an invalid query %s", async (query) => {
    const response = await catalogRequest(`/api/search?${query}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toHaveProperty("error", "Invalid catalog request.");
  });

  it.each(["POST", "PATCH", "DELETE", "PUT"])("rejects %s without reaching catalog assets", async (method) => {
    const env = catalogEnvironment();
    for (const path of ["/api/import", "/api/items/one", "/api/items/one/analyze", "/catalog/catalog.json", "/"]) {
      expect((await catalogRequest(path, env, { method })).status).toBe(405);
    }
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it("returns JSON 404s for unknown API paths instead of the app shell", async () => {
    const response = await catalogRequest("/api/unknown");
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect((await catalogRequest("/mcp/unknown")).status).toBe(404);
    expect((await catalogRequest("/catalog/items/one.json")).status).toBe(404);
  });

  it("reports a failed snapshot as service failure without exposing diagnostics", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const env: CatalogWorkerEnv = { ASSETS: { fetch: async () => Response.json({ private: "PRIVATE_NOTE_SENTINEL" }) } };
    const response = await catalogRequest("/api/overview", env);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("PRIVATE_");
  });
});

describe("catalog MCP", () => {
  it("lets an SDK client discover only the four read-only tools", async () => {
    const client = await catalogClient();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["inspo_overview", "inspo_search", "inspo_context", "inspo_get_reference"]);
    expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
  });

  it("returns the same overview, search, and context as the JSON API", async () => {
    const client = await catalogClient();
    for (const [name, path, args] of [
      ["inspo_overview", "/api/overview", {}],
      ["inspo_search", "/api/search?tags=editorial,warm&mode=or&limit=1", { tags: ["editorial", "warm"], mode: "or", limit: 1 }],
      ["inspo_context", "/api/context?tags=editorial,warm", { tags: ["editorial", "warm"] }],
      ["inspo_context", "/api/context?tags=absent", { tags: ["absent"] }],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual(await (await catalogRequest(path)).json());
      expect(JSON.stringify(result)).not.toContain("PRIVATE_");
    }
  });

  it("returns a saved image only on explicit inspection and reports missing references", async () => {
    const client = await catalogClient();
    const metadata = await client.callTool({ name: "inspo_get_reference", arguments: { id: "one" } });
    expect(metadata.content.every((content) => content.type !== "image")).toBe(true);
    const inspected = await client.callTool({ name: "inspo_get_reference", arguments: { id: "one", includeImage: true } });
    expect(inspected.content).toContainEqual({ type: "image", data: btoa("saved image"), mimeType: "image/webp" });
    const missing = await client.callTool({ name: "inspo_get_reference", arguments: { id: "missing" } });
    expect(missing.isError).toBe(true);
  });

  it("keeps oversized images out of tool results", async () => {
    const env = catalogEnvironment();
    const originalFetch = env.ASSETS.fetch;
    env.ASSETS.fetch = async (request) => new URL(request.url).pathname.startsWith("/catalog/media/")
      ? new Response("large image", { headers: { "content-length": "2097153" } })
      : originalFetch(request);
    const client = await catalogClient(env);
    const result = await client.callTool({ name: "inspo_get_reference", arguments: { id: "one", includeImage: true } });
    expect(result.content.every((content) => content.type !== "image")).toBe(true);
    expect(JSON.stringify(result.content)).toContain("2 MiB inline limit");
  });

  it("rejects invalid tool arguments instead of broadening a search", async () => {
    const client = await catalogClient();
    const result = await client.callTool({ name: "inspo_search", arguments: { mode: "invalid" } });
    expect(result.isError).toBe(true);
  });

  it("validates browser origins while allowing native clients and configured web clients", async () => {
    expect((await catalogRequest("/mcp", undefined, { method: "OPTIONS", headers: { origin: "https://untrusted.example" } })).status).toBe(403);
    const env = catalogEnvironment();
    env.MCP_ALLOWED_ORIGINS = "https://agent.example";
    const preflight = await catalogRequest("/mcp", env, { method: "OPTIONS", headers: { origin: "https://agent.example" } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("https://agent.example");
    expect((await catalogRequest("/mcp", env, { method: "OPTIONS", headers: { origin: "https://agent.example:8443" } })).status).toBe(403);
    const initialized = await catalogRequest("/mcp", env, { method: "POST", headers: {
      origin: "https://agent.example", "content-type": "application/json", accept: "application/json, text/event-stream",
    }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "browser-client", version: "1" },
    } }) });
    expect(initialized.status).toBe(200);
    expect(initialized.headers.get("access-control-expose-headers")).toContain("MCP-Protocol-Version");
    await initialized.text();
    expect((await catalogRequest("/mcp", env, { method: "GET" })).status).toBe(405);
  });

  it("supports legacy Streamable HTTP clients without storing a session", async () => {
    const env = catalogEnvironment();
    const rpc = async (message: object) => {
      const response = await catalogRequest("/mcp", env, { method: "POST", headers: {
        "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18",
      }, body: JSON.stringify(message) });
      const text = await response.text();
      const payload = response.headers.get("content-type")?.includes("text/event-stream") ? text.match(/^data: (.+)$/m)?.[1] : text;
      expect(response.status).toBe(200);
      expect(response.headers.has("mcp-session-id")).toBe(false);
      return JSON.parse(payload!);
    };
    const initialized = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "legacy-client", version: "1" } } });
    expect(initialized.result.serverInfo.name).toBe("design-inspo");
    const listed = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect(listed.result.tools).toHaveLength(4);
  });

  it("rejects oversized MCP request bodies", async () => {
    const response = await catalogRequest("/mcp", undefined, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: " ".repeat(131073) });
    expect(response.status).toBe(413);
  });
});

import { existsSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import multer from "multer";
import { ZodError } from "zod";
import { analyzeItem, type AnalysisProvider } from "./analysis.js";
import {
  createItem,
  deleteItem,
  getAllItems,
  getIndex,
  getItem,
  getTaxonomy,
  importFromUrl,
  paths,
  rebuildIndex,
  updateItem,
  writeItem,
} from "./catalog.js";
import { buildContext, type FilterMode } from "./context.js";

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } });
const port = Number(process.env.PORT ?? 8787);

app.use(express.json({ limit: "1mb" }));
app.use("/media", express.static(paths.media, { fallthrough: false, maxAge: "7d" }));

app.get("/api/health", (_request, response) => response.json({ ok: true }));
app.get("/api/catalog", async (_request, response, next) => {
  try {
    response.json(await getIndex());
  } catch (error) {
    next(error);
  }
});
app.get("/api/taxonomy", async (_request, response, next) => {
  try {
    response.json(await getTaxonomy());
  } catch (error) {
    next(error);
  }
});
app.get("/api/items/:id", async (request, response, next) => {
  try {
    response.json(await getItem(request.params.id));
  } catch (error) {
    next(error);
  }
});

app.post("/api/import", upload.single("file"), async (request, response, next) => {
  try {
    const title = typeof request.body.title === "string" ? request.body.title : undefined;
    if (request.file) {
      const item = await createItem({
        title: title || request.file.originalname.replace(/\.[^.]+$/, ""),
        buffer: request.file.buffer,
        captureMethod: "upload",
      });
      response.status(201).json({ item, message: "Image saved and ready for analysis." });
      return;
    }
    if (typeof request.body.url !== "string" || !request.body.url.trim()) {
      response.status(400).json({ error: "Drop an image or provide a URL." });
      return;
    }
    const item = await importFromUrl(request.body.url.trim(), title);
    response.status(201).json({
      item,
      message: item.media
        ? "Preview image saved from public page metadata."
        : "Source saved. Its preview could not be retrieved, so add a screenshot when convenient.",
    });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/items/:id", async (request, response, next) => {
  try {
    const body = request.body as Record<string, unknown>;
    const patch = {
      ...(typeof body.title === "string" ? { title: body.title.trim() } : {}),
      ...(typeof body.notes === "string" ? { notes: body.notes } : {}),
      ...(typeof body.sourceUrl === "string" || body.sourceUrl === null ? { sourceUrl: body.sourceUrl } : {}),
      ...(Array.isArray(body.manualTagIds) && body.manualTagIds.every((tag) => typeof tag === "string")
        ? { manualTagIds: body.manualTagIds }
        : {}),
    };
    response.json(await updateItem(request.params.id, patch));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/items/:id", async (request, response, next) => {
  try {
    await deleteItem(request.params.id);
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.post("/api/context", async (request, response, next) => {
  try {
    const tags = Array.isArray(request.body.tags) ? request.body.tags.filter((tag: unknown): tag is string => typeof tag === "string") : [];
    const mode: FilterMode = request.body.mode === "or" ? "or" : "and";
    response.json(buildContext(await getAllItems(), tags, mode));
  } catch (error) {
    next(error);
  }
});

app.post("/api/items/:id/analyze", async (request, response, next) => {
  try {
    const item = await getItem(request.params.id);
    if (!item.media) {
      response.status(400).json({ error: "Add an image before analysis." });
      return;
    }
    const provider: AnalysisProvider = request.body?.provider === "openai" ? "openai" : "opencode";
    try {
      const analysis = await analyzeItem(item, join(paths.root, item.media.path), await getTaxonomy(), provider);
      const updated = await writeItem({
        ...item,
        title: analysis.title,
        analysis,
        analysisStatus: "ready",
        updatedAt: new Date().toISOString(),
      });
      await rebuildIndex();
      response.json(updated);
    } catch (error) {
      await writeItem({ ...item, analysisStatus: "failed", updatedAt: new Date().toISOString() });
      await rebuildIndex();
      throw error;
    }
  } catch (error) {
    next(error);
  }
});

if (existsSync(paths.dist)) {
  app.use(express.static(paths.dist));
  app.get("/{*path}", (_request, response) => response.sendFile(join(paths.dist, "index.html")));
}

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  const status = error instanceof ZodError ? 422 : 400;
  const message = error instanceof Error ? error.message : "Unexpected server error.";
  response.status(status).json({ error: message });
});

rebuildIndex()
  .catch((error: unknown) => {
    console.error("Could not build catalog index", error);
    process.exitCode = 1;
  })
  .then(() => {
    app.listen(port, "127.0.0.1", () => {
      console.log(`Field Notes is running at http://127.0.0.1:${port}`);
    });
  });
